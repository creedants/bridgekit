//   npm run build            && npm run smoke:preview    (serves dist/ itself)
//   npm run build:cloudflare && npm run smoke:wrangler   (local wrangler dev)
//   npm run dev   (in another terminal)
//   npm run smoke [-- http://localhost:5173] [rows]
//   CHROMIUM=/path/to/chrome starts that browser. The default is chromium on PATH.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./cdp.mjs";

/** @typedef {{ kind: "preview" } | { kind: "wrangler" } | { kind: "url", origin: string }} Target */
/** @typedef {{ origin: string, stop: () => Promise<void> }} Server */

const DEBUG_PORT = 9360;
const CHROMIUM = process.env.CHROMIUM || "chromium";
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name) => join(root, "node_modules/.bin", name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

function devPort() {
  const port = /"port"\s*:\s*(\d+)/.exec(readFileSync(join(root, "wrangler.jsonc"), "utf8"))?.[1];
  if (!port) fail("wrangler.jsonc names no dev port");
  return port;
}

const has = (assets, suffix) => assets.some((name) => name.endsWith(suffix));
// Its own D1 state and secret file, so a run shares nothing with npm run cf:dev or npm run perf:worker.
// The lists are constants: no caller-supplied flag reaches wrangler.
const local = (dir) => ["--persist-to", join(dir, "state"), `--env-file=${join(dir, "auth.env")}`];

const BUILDS = {
  preview: {
    origin: "http://127.0.0.1:4173",
    server: "vite preview",
    holds: "the default build (uncompressed wasm)",
    built: (assets) => has(assets, ".wasm"),
    rebuild: "npm run build",
    secrets: [],
    prepare: () => [],
    command: () => [bin("vite"), "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
    policies: 1, // the meta tag
  },
  wrangler: {
    origin: `http://127.0.0.1:${devPort()}`,
    server: "local wrangler dev",
    holds: "the Cloudflare build (compressed wasm only)",
    built: (assets) => has(assets, ".wasm.br") && !has(assets, ".wasm"),
    rebuild: "npm run build:cloudflare",
    secrets: ["BETTER_AUTH_SECRET"],
    prepare: (dir) => [[bin("wrangler"), "d1", "migrations", "apply", "bridgekit", "--local", ...local(dir)]],
    command: (dir) => [bin("wrangler"), "dev", "--port", devPort(), "--ip", "127.0.0.1", ...local(dir)],
    policies: 2, // the meta tag, and the header from public/_headers
  },
};

/** @returns {{ target: Target, rows: string }} */
function parseTarget(argv) {
  const usage = () => {
    console.error("usage: node scripts/smoke.mjs [--serve preview|wrangler | url] [rows]");
    process.exit(2);
  };
  const served = argv[0] === "--serve";
  const [where, rows = "", ...extra] = served ? argv.slice(1) : argv;
  if (extra.length || !/^\d*$/.test(rows)) usage();
  if (served) return Object.hasOwn(BUILDS, where ?? "") ? { target: { kind: where }, rows } : usage();
  const url = where ?? "http://localhost:5173";
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) usage();
  return { target: { kind: "url", origin: new URL(url).origin }, rows };
}

/** The whole environment of every server this script starts. Nothing is inherited but PATH. */
function childEnv(dir) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_RUNTIME_DIR: join(dir, "run"),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_PATH: join(dir, "logs"),
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
  };
  // scripts/perf/worker.mjs runs its benchmark on import, so the list it keeps is read as text.
  const source = readFileSync(join(root, "scripts/perf/worker.mjs"), "utf8");
  const theirs = /function wranglerEnv\(\) \{[\s\S]*?return \{([\s\S]*?)\};/.exec(source)?.[1].match(/\b[A-Z_]+(?=:)/g) ?? [];
  if (theirs.sort().join() !== Object.keys(env).sort().join()) {
    fail(`the server environment in scripts/smoke.mjs no longer matches wranglerEnv() in scripts/perf/worker.mjs (${theirs.join(", ")})`);
  }
  return env;
}

/** @param {Target} target @returns {Promise<Server>} */
async function serve(target) {
  if (target.kind === "url") return { origin: target.origin, stop: async () => {} };
  const build = BUILDS[target.kind];
  let assets = [];
  try { assets = readdirSync(join(root, "dist/assets")); } catch {}
  if (!build.built(assets)) {
    const held = Object.values(BUILDS).find((other) => other.built(assets));
    fail(`dist/ holds ${held?.holds ?? "no build"}. Run ${build.rebuild}, then npm run smoke:${target.kind}.`);
  }
  // A listening port is not ownership: a server someone else started is neither tested nor stopped.
  if (await fetch(build.origin, { signal: AbortSignal.timeout(3000) }).then(() => true, (error) => error.name === "TimeoutError")) fail(`${build.origin} already answers. Stop that server and run this again.`);

  const dir = mkdtempSync(join(tmpdir(), "bridgekit-smoke-"));
  const secrets = build.secrets.map((name) => [name, randomBytes(32).toString("hex")]);
  const scrub = (text) => secrets.reduce((clean, [, value]) => clean.replaceAll(value, "<redacted>"), text.replace(/\u001b\[[0-9;]*m/g, ""));
  let child = null, log = "", gone = null;
  const tail = () => scrub(log).slice(-2000);
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
  const quit = async () => {
    // The child leads its own process group, so this reaches what it started (workerd) too.
    for (const [signal, ms] of [["SIGTERM", 4000], ["SIGKILL", 2000]]) {
      try { process.kill(-child.pid, signal); } catch { break; }
      for (const end = Date.now() + ms; alive() && Date.now() < end; ) await sleep(50);
    }
    const left = alive() ? child.pid : null;
    child = null;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (left) fail(`the server's process group ${left} did not exit`);
  };
  // process.exit() and a signal skip every await, so this stops the server without one.
  process.once("exit", () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    for (const name of ["home", "config", "cache", "state", "run", "tmp", "logs"]) mkdirSync(join(dir, name), { mode: 0o700 });
    writeFileSync(join(dir, "auth.env"), secrets.map(([name, value]) => `${name}=${value}\n`).join(""), { flag: "wx", mode: 0o600 });
    const env = childEnv(dir);
    for (const [command, ...args] of build.prepare(dir)) {
      const done = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
      if (done.status !== 0) fail(`wrangler ${args.slice(0, 3).join(" ")} failed (${done.error?.message ?? `exit ${done.status}`})\n${scrub(`${done.stdout ?? ""}${done.stderr ?? ""}`).slice(-2000)}`);
    }
    const [command, ...args] = build.command(dir);
    child = spawn(command, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", (error) => { gone ??= error.message; });
    child.once("exit", (code, signal) => { gone ??= `exit ${signal ?? code}`; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-200_000); });
    const deadline = Date.now() + 120_000;
    while (!(await fetch(`${build.origin}/app/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false))) {
      if (gone) fail(`${build.server} stopped before it answered (${gone})\n${tail()}`);
      if (Date.now() > deadline) fail(`${build.origin}/app/ did not answer within 120 s\n${tail()}`);
      await sleep(200);
    }
  } catch (error) {
    await quit();
    throw error;
  }
  console.log(`serving dist/ with ${build.server} on ${build.origin}`);
  return {
    origin: build.origin,
    stop: async () => {
      const exited = gone;
      await quit();
      if (exited) fail(`the server exited during the test (${exited})\n${tail()}`);
      console.log("ok  server stopped");
    },
  };
}

/**
 * Why this attempt could carry data off this origin, or null. A blocked attempt still counts: the code tried.
 * @param {import("./cdp.mjs").NetworkRecord} record
 */
function leak({ url, method, hasBody, blocked }, origin, { devServer }) {
  if (/^(blob|data):/.test(url)) return null;
  const to = URL.canParse(url) ? new URL(url) : null;
  // Vite's hot-reload socket, which only a dev server has.
  if (method === "WEBSOCKET") return devServer && to?.host === new URL(origin).host ? null : "websocket";
  if (method !== "GET") return "method";
  if (hasBody) return "body";
  if (to?.origin !== origin) return "another host" + (blocked ? `, blocked by ${blocked}` : "");
  return null;
}

const blob = (source) => `URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "text/javascript" }))`;

const PROVEN = {
  worker: (script) => `new Promise((done) => { window.__canary = new Worker(${blob(`${script}.then(() => postMessage(1));`)}); window.__canary.onmessage = () => done(); setTimeout(done, 10000); })`,
  shared_worker: (script) => `new Promise((done) => { window.__canaryShared = new SharedWorker(${blob(`const asked = ${script}; onconnect = (e) => asked.then(() => e.ports[0].postMessage(1));`)}); window.__canaryShared.port.onmessage = () => done(); setTimeout(done, 10000); })`,
  page: (script) => script,
};

/** @typedef {import("./cdp.mjs").Recording} Recording */

/**
 * What one control attempt must leave in a finished record, on a page that enforces `policies` policies.
 * Written here. Never read back from a run.
 */
const CONTROL = {
  // Chromium refuses a fetch() the policy blocks before it becomes a request, so only the policy reports it.
  fetch: (policies) => ({ records: policies ? 0 : 1, blocked: null, reports: policies }),
  XMLHttpRequest: (policies) => ({ records: 1, blocked: policies ? "csp" : null, reports: policies }),
  // Sent to this origin while the document is left. The policy allows that, so it is one request on every build.
  sendBeacon: () => ({ records: 1, blocked: null, reports: 0 }),
  keepalive: () => ({ records: 1, blocked: null, reports: 0 }),
};

/** @typedef {{ from: string, how: keyof typeof CONTROL, url: string }} Ask */

/** @returns {Ask[]} */
function asks(origin) {
  const port = `http://127.0.0.1:${DEBUG_PORT}`;
  const cross = Object.keys(PROVEN).flatMap((from) => ["fetch", "XMLHttpRequest"].map((how) => ({ from, how, url: `${port}/json/version?${from}-${how}` })));
  const leave = ["sendBeacon", "keepalive"].map((how) => ({ from: "page", how, url: `${origin}/app/?control-${how}` }));
  return [...cross, ...leave];
}

/** The pagehide listener for the two leave attempts. Both go to this origin, which the policy allows. */
function onLeave(origin) {
  const beacon = `${origin}/app/?control-sendBeacon`;
  const keep = `${origin}/app/?control-keepalive`;
  return `addEventListener("pagehide", () => { navigator.sendBeacon(${JSON.stringify(beacon)}, "x"); fetch(${JSON.stringify(keep)}, { method: "POST", body: "x", keepalive: true }); })`;
}

/** Loads /app/, makes every attempt in asks(), and says whether the document declares a policy. */
async function ask(browser, origin) {
  await browser.goto(`${origin}/app/`);
  // fetch() and the engine's own way of asking, a synchronous XMLHttpRequest. Both are issued before the first await.
  const script = (from) => {
    const fetchUrl = asks(origin).find((item) => item.from === from && item.how === "fetch").url;
    const xhrUrl = asks(origin).find((item) => item.from === from && item.how === "XMLHttpRequest").url;
    return `(async () => { const tried = fetch(${JSON.stringify(fetchUrl)}).catch(() => {}); try { const ask = new XMLHttpRequest(); ask.open("GET", ${JSON.stringify(xhrUrl)}, false); ask.send(); } catch {} await tried; })()`;
  };
  for (const from of Object.keys(PROVEN)) await browser.evalJs(PROVEN[from](script(from)));
  await browser.evalJs(onLeave(origin));
  return browser.evalJs(`!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`);
}

/**
 * Why this record does not prove the recorder, or null.
 * @param {Recording} record
 * @param {string} origin
 * @param {number} policies
 * @returns {string | null}
 */
function proves(record, origin, policies) {
  for (const item of asks(origin)) {
    const expect = CONTROL[item.how](policies);
    const records = record.network.filter((entry) => entry.url === item.url);
    const reports = record.violations.filter((entry) => entry.url === item.url);
    const leave = item.how === "sendBeacon" || item.how === "keepalive";
    if (records.length !== expect.records) return `${records.length} records of the ${item.from}'s ${item.how}, expected ${expect.records}. The record has ${record.network.map((entry) => `${entry.from} ${entry.method} ${entry.url}`).join("; ")}`;
    for (const entry of records) {
      if (!leak(entry, origin, { devServer: false })) return `the request check did not flag the ${item.from}'s ${item.how}`;
      if (entry.blocked !== expect.blocked) return `the ${item.from}'s ${item.how} has blocked ${entry.blocked}, expected ${expect.blocked}`;
      if (!leave && entry.from !== item.from) return `the ${item.from}'s ${item.how} was recorded from ${entry.from}`;
    }
    if (reports.length !== expect.reports) return `${reports.length} policy reports of the ${item.from}'s ${item.how}, expected ${expect.reports} (${reports.map((entry) => `${entry.from} ${entry.directive} ${entry.url}`).join("; ")})`;
  }
  return null;
}

async function drive(browser, origin, rows) {
  console.log(`browser: ${(await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).Browser}`);
  await browser.size(1360, 1000);
  const started = Date.now();
  const sample = `${origin}/app/?sample${rows ? "=" + rows : ""}`;
  await browser.goto(sample);
  await browser.waitFor("!!document.querySelector('.kpis')", 600).catch((error) => fail(`the sample at ${sample} did not load and calculate within 150 s (${error.message})`));
  console.log(`sample loaded and calculated in ${Date.now() - started} ms`);

  const bridge = JSON.parse(
    await browser.evalJs(
      "JSON.stringify([...document.querySelectorAll('.bridge table')[0].rows].slice(1).map(r => Number(r.cells[1].innerText.replace(/[,+]/g, ''))))",
    ),
  );
  const [prior, ...rest] = bridge;
  const current = rest.pop();
  const residual = prior + rest.reduce((a, b) => a + b, 0) - current;
  if (Math.abs(residual) > rest.length) fail(`bridge does not add up (off by ${residual})`);
  console.log(`bridge adds up: ${prior} + effects = ${current}`);

  const tabs = ["Movers", "Accounts", "Price changes", "Price gaps", "Trend", "Unmatched", "Setup check", "Data check", "Bridge"];
  for (const tab of tabs) {
    await browser.evalJs(`T.tab(${JSON.stringify(tab)})`);
    await browser.sleep(1500);
    const state = JSON.parse(
      await browser.evalJs(
        "JSON.stringify({ error: T.err(), text: document.querySelector('main').innerText.length, overflow: document.documentElement.scrollWidth - innerWidth })",
      ),
    );
    if (state.error) fail(`${tab}: ${state.error}`);
    if (state.text < 200) fail(`${tab}: tab looks empty`);
    if (state.overflow > 0) fail(`${tab}: page overflows by ${state.overflow}px`);
    console.log(`ok  ${tab}`);
  }

  const exported = JSON.parse(
    await browser.evalJs(`(async () => {
      let blob = null; const original = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return original(b); };
      const t = performance.now(); T.btn('Export Excel').click();
      for (let i = 0; i < 400 && !blob; i++) await new Promise(r => setTimeout(r, 200));
      URL.createObjectURL = original;
      return JSON.stringify({ bytes: blob?.size ?? 0, ms: Math.round(performance.now() - t), error: T.err() });
    })()`),
  );
  if (exported.error || exported.bytes < 10_000) fail(`Excel export: ${exported.error ?? "no file"}`);
  console.log(`ok  Excel export (${exported.bytes} bytes in ${exported.ms} ms)`);

  await browser.goto(`${origin}/app/`);
  await browser.send("DOM.enable");
  const { root } = await browser.send("DOM.getDocument");
  const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
  await browser.send("DOM.setFileInputFiles", { nodeId, files: [new URL("../public/sample-sales.csv", import.meta.url).pathname] });
  await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
  await browser.evalJs(`T.set(document.querySelector('select[aria-label="Add attribute"]'), 'design')`);
  await browser.sleep(300);
  await browser.evalJs(`T.set(document.querySelector('select[aria-label="Add filter"]'), 'customer')`);
  await browser.waitFor("document.querySelectorAll('.values input').length > 0");
  await browser.evalJs("document.querySelector('.values input').click()");
  await browser.sleep(800);
  await browser.evalJs("T.btn('Calculate bridge').click()");
  await browser.waitFor("!!document.querySelector('.kpis')");
  await browser.sleep(1500);

  const selected = await browser.evalJs("document.querySelector('.values input:checked').closest('label').textContent.trim()");
  const stored = JSON.parse(
    await browser.evalJs(`(async () => {
      let opfs = 0;
      try { for await (const _ of (await navigator.storage.getDirectory()).keys()) opfs++; } catch {}
      return JSON.stringify({
        localStorage: Object.fromEntries(Object.entries(localStorage)),
        sessionStorage: Object.keys(sessionStorage),
        cookies: document.cookie,
        indexedDB: (await indexedDB.databases()).map((d) => d.name),
        caches: await caches.keys(),
        opfs,
        serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
      });
    })()`),
  );
  const kept = Object.entries(stored).filter(
    ([key, value]) => key !== "localStorage" && (Array.isArray(value) ? value.length : value),
  );
  if (kept.length) fail(`data left in the browser: ${JSON.stringify(Object.fromEntries(kept))}`);
  console.log("ok  storage: nothing in sessionStorage, cookies, IndexedDB, caches, private file system or service workers");

  // Remembering is on by default: localStorage holds one setup per set of
  // columns used (the sample data and this file) and nothing else, with no
  // filter selection or other value from the data.
  const entries = Object.entries(stored.localStorage);
  if (entries.length !== 2 || !entries.every(([key]) => key.startsWith("bridgekit:setup:"))) {
    fail(`unexpected localStorage: ${JSON.stringify(Object.keys(stored.localStorage))}`);
  }
  for (const [, value] of entries) {
    if (JSON.parse(value).filters.length) fail("a filter selection was stored");
    if (value.includes(`"${selected}"`)) fail("a data value was stored");
  }
  console.log("ok  remember setup (default): stores the column mapping only");

  const loadCsv = async () => {
    await browser.goto(`${origin}/app/`);
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
    await browser.send("DOM.setFileInputFiles", { nodeId, files: [new URL("../public/sample-sales.csv", import.meta.url).pathname] });
    await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
  };
  const rememberBox = "[...document.querySelectorAll('.check input')].find(i => i.closest('label').textContent.includes('Remember'))";

  await browser.evalJs("T.btn('Clear data').click()");
  await browser.sleep(1500);
  if (!(await browser.evalJs("!document.querySelector('aside') && document.body.innerText.includes('Load a sales file')"))) fail("Clear data did not reset the tool");
  console.log("ok  clear data returns to the empty tool");

  // The next file with the same columns opens with the remembered setup, minus filters.
  await loadCsv();
  const restored = await browser.evalJs(
    "document.body.innerText.includes('Restored the setup') && document.querySelectorAll('.values input:checked').length === 0",
  );
  if (!restored) fail("the remembered setup was not restored without its filters");
  console.log("ok  remember setup: restored on the next load, without filter selections");

  // Unticking deletes the setup and keeps only the "off" choice, which survives a reload.
  await browser.evalJs(`${rememberBox}.click()`);
  await browser.sleep(300);
  const afterOff = await browser.evalJs("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))");
  if (afterOff !== JSON.stringify({ "bridgekit:remember": "off" })) fail(`opting out left data in localStorage: ${afterOff}`);
  console.log("ok  remember setup: unticking deletes what was stored");

  await loadCsv();
  if (!(await browser.evalJs(`!${rememberBox}.checked && localStorage.length === 1`))) fail("remembering turned itself back on after a reload");
  console.log("ok  remember setup: staying off survives a reload");
}

/**
 * Every rule that decides pass or fail, over the whole record.
 * @param {Recording} record
 * @param {string} origin
 * @param {{ devServer: boolean }} opts
 * @returns {{ failures: string[], notes: string[] }}
 */
function judge(record, origin, { devServer }) {
  const failures = [];
  const notes = [];
  const leaks = record.network.flatMap((entry) => {
    const why = leak(entry, origin, { devServer });
    return why ? [`[${entry.from}] ${entry.method} ${entry.url} (${why})`] : [];
  });
  if (leaks.length) failures.push(`requests that could carry data: ${leaks.slice(0, 5).join("; ")}`);
  else {
    const bySource = [...new Set(record.network.map((entry) => entry.from))].map((from) => `${record.network.filter((entry) => entry.from === from).length} ${from}`);
    notes.push(`ok  network: ${record.network.length} requests (${bySource.join(", ")}), all GET to ${origin}`);
  }
  if (record.violations.length) failures.push(`content policy violations: ${[...new Set(record.violations.map((entry) => `[${entry.from}] ${entry.directive} ${entry.url}`))].join("; ")}`);
  else notes.push("ok  policy: no violation from the page or a worker");
  const unproven = record.askers.filter((asker) => !Object.hasOwn(PROVEN, asker.kind));
  if (unproven.length) failures.push(`a ${unproven[0].kind} ran (${unproven[0].url}), and the control proves only that ${Object.keys(PROVEN).join(", ")} requests are seen`);
  const by = (from, file) => record.network.find((entry) => entry.from === from && URL.canParse(entry.url) && file.test(new URL(entry.url).pathname));
  const seen = [by("page", /^\/app\/$/), by("worker", /\/duckdb-browser-[^/]*\.worker[^/]*\.js$/), by("worker", /\/duckdb-[^/]*\.wasm$/)];
  if (!seen.every(Boolean)) failures.push("the page's request for /app/ and the database worker's requests for its script and its wasm were not all recorded, so the request check did not see the application");
  else notes.push(`ok  recorded: ${seen.map((entry) => new URL(entry.url).pathname).join(", ")}`);
  return { failures, notes };
}

/** Opens a recording browser, runs `steps`, and returns the record after the browser has exited. */
async function recorded(steps) {
  const browser = await open(DEBUG_PORT, { chromium: CHROMIUM, record: true });
  try {
    const result = await steps(browser);
    return { result, record: await browser.finish() };
  } finally {
    await browser.close();
  }
}

const { target, rows } = parseTarget(process.argv.slice(2));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
const failures = [];
let server = null;
try {
  server = await serve(target);
  const origin = server.origin;
  console.log(`starting ${CHROMIUM}${process.env.CHROMIUM ? "" : " from PATH (set CHROMIUM to start another browser)"}`);
  const control = await recorded((browser) => ask(browser, origin));
  const policies = target.kind === "url" ? Number(control.result) : BUILDS[target.kind].policies;
  if (!control.result && target.kind !== "url") fail(`${origin}/app/ carries no content security policy, and a built site must`);
  if (policies === 0) console.log(`note: ${origin} sends no content security policy (a dev server). Run npm run build && npm run smoke:preview for the full check.`);
  const unproven = proves(control.record, origin, policies);
  if (unproven) fail(`canary: ${unproven}, so a request to another host could go unseen`);
  console.log(`ok  canary: a worker, a shared worker and the page each asked http://127.0.0.1:${DEBUG_PORT} by fetch and by XMLHttpRequest, and each attempt was ${policies ? "refused by the policy and reported" : "recorded and flagged"}`);
  const app = await recorded((browser) => drive(browser, origin, rows));
  const judged = judge(app.record, origin, { devServer: policies === 0 });
  for (const note of judged.notes) console.log(note);
  if (judged.failures.length) fail(judged.failures.join("\n"));
} catch (error) {
  failures.push(error);
} finally {
  await server?.stop().catch((error) => failures.push(error));
}
if (failures.length) {
  for (const failure of failures) console.error("FAIL: " + (failure instanceof Failure ? failure.message : failure.stack));
  process.exit(1);
}
console.log("smoke test passed");
