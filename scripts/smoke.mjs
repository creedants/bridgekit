//   npm run build            && npm run smoke:preview    (serves dist/ itself)
//   npm run build:cloudflare && npm run smoke:wrangler   (local wrangler dev, accounts on)
//   npm run dev   (in another terminal)
//   npm run smoke [-- http://localhost:5173] [rows]
//   CHROMIUM=/path/to/chrome starts that browser. The default is chromium on PATH.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./cdp.mjs";
import { openDatabase } from "../src/duckdb.ts";
import { runBridge } from "../src/engine.ts";
import { whole, signedWhole } from "../src/app/format.ts";
import { PERIOD, VIEW, viewSql } from "../src/app/setup.ts";
import {
  FIXTURE_HEADER,
  FIXTURE_LEVELS,
  FORMATTED_CURRENT,
  FORMATTED_PRIOR,
  toTsvText,
  writeFixtures,
} from "./smoke-files.mjs";

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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseBridgeAmount(raw, where) {
  if (raw === "") fail(`${where} amount is missing`);
  const spelled = whole(-1234567);
  const runs = [...spelled.matchAll(/\d+/g)];
  const width = runs.at(-1)[0].length;
  const group = spelled.slice(runs.at(-2).index + runs.at(-2)[0].length, runs.at(-1).index);
  const minus = spelled.slice(0, runs[0].index);
  const plain = whole(1);
  const signed = signedWhole(1);
  const plus = signed.endsWith(plain) ? signed.slice(0, -plain.length) : "";
  const signs = [plus, minus].filter((sign) => sign !== "").map(escapeRegExp);
  const sign = signs.length ? `(?:${signs.join("|")})?` : "";
  const pattern = new RegExp(`^${sign}\\d{1,${width}}(?:${escapeRegExp(group)}\\d{${width}})*$`);
  if (!pattern.test(raw)) fail(`${where} amount is ${JSON.stringify(raw)}`);
  const value = Number(raw.split(group).join(""));
  const rendered = plus !== "" && raw.startsWith(plus) ? signedWhole(value) : whole(value);
  if (!Number.isFinite(value) || raw !== rendered) fail(`${where} amount is ${JSON.stringify(raw)}`);
  return value;
}

function parseCssColor(text) {
  const source = String(text ?? "");
  const comma = /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)(%)?\s*)?\)/.exec(source);
  const space = /rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)(%)?\s*)?\)/.exec(source);
  const match = comma || space;
  if (!match) return null;
  const channels = [match[1], match[2], match[3]].map(Number);
  if (channels.some((channel) => !Number.isFinite(channel))) return null;
  let alpha = 1;
  if (match[4] != null && match[4] !== "") {
    alpha = Number(match[4]);
    if (!Number.isFinite(alpha)) return null;
    if (match[5] === "%") alpha /= 100;
  }
  return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
}

function colorsDiffer(left, right) {
  return left.r !== right.r || left.g !== right.g || left.b !== right.b || left.a !== right.a;
}

function backdropColor(backgrounds) {
  if (!Array.isArray(backgrounds)) return null;
  for (const css of backgrounds) {
    const color = parseCssColor(css);
    if (color && color.a > 0) return color;
  }
  return null;
}

function outlinePaints(snapshot, backdrop) {
  if (snapshot.outlineStyle === "none" || snapshot.outlineStyle === "hidden") return false;
  const width = Number.parseFloat(snapshot.outlineWidth);
  if (!(width > 0)) return false;
  const color = parseCssColor(snapshot.outlineColor);
  if (!color || !(color.a > 0) || !colorsDiffer(color, backdrop)) return false;
  return true;
}

function splitBoxShadow(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text === "none") return [];
  const pieces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      const piece = text.slice(start, i).trim();
      if (piece) pieces.push(piece);
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) pieces.push(last);
  return pieces;
}

function shadowPaints(piece, backdrop) {
  if (/\binset\b/.test(piece)) return false;
  const lengths = [...piece.matchAll(/(-?(?:\d+\.\d+|\d+|\.\d+))px/g)].map((match) => Number(match[1]));
  if (lengths.length < 2 || lengths.length > 4) return false;
  const [x, y, blur = 0, spread = 0] = lengths;
  if (!(spread > 0 || blur > 0 || x !== 0 || y !== 0)) return false;
  const color = parseCssColor(piece);
  if (!color || !(color.a > 0) || !colorsDiffer(color, backdrop)) return false;
  return true;
}

function ringVisible(snapshot) {
  if (!snapshot || snapshot.missing) return false;
  const backdrop = backdropColor(snapshot.backgrounds);
  if (!backdrop) return false;
  if (outlinePaints(snapshot, backdrop)) return true;
  return splitBoxShadow(snapshot.boxShadow).some((piece) => shadowPaints(piece, backdrop));
}

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
    policy: { headers: 0, metas: 1 },
  },
  wrangler: {
    origin: `http://127.0.0.1:${devPort()}`,
    server: "local wrangler dev",
    holds: "the Cloudflare build (compressed wasm only)",
    built: (assets) => has(assets, ".wasm.br") && !has(assets, ".wasm"),
    rebuild: "npm run build:cloudflare",
    secrets: ["BETTER_AUTH_SECRET"],
    prepare: (dir) => [[bin("wrangler"), "d1", "migrations", "apply", "bridgekit", "--local", ...local(dir)]],
    // The Cloudflare build asks for the session on load, and the Worker answers
    // account routes with 404 unless ACCOUNTS is exactly "on", so this local run
    // starts it open. LOCAL_EMAIL_LOG writes a sign-in link to the log instead of
    // refusing it. Both are constants for this test; they protect nothing.
    command: (dir) => [
      bin("wrangler"), "dev", "--port", devPort(), "--ip", "127.0.0.1", ...local(dir),
      "--var", "ACCOUNTS:on", "--var", "LOCAL_EMAIL_LOG:on",
    ],
    policy: { headers: 1, metas: 1 },
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

/** Every recorded request that could carry data off this origin, named. The caller removes the records it means to exempt. */
function strays(entries, origin, devServer) {
  return entries.flatMap((entry) => {
    const why = leak(entry, origin, { devServer });
    return why ? [`[${entry.from}] ${entry.method} ${entry.url} (${why})`] : [];
  });
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

/** @typedef {{ from: string, how: keyof typeof CONTROL, method: string, url: string }} Ask */

/** @returns {Ask[]} The control requests and the literal method each uses. */
function asks(origin) {
  const port = `http://127.0.0.1:${DEBUG_PORT}`;
  const cross = Object.keys(PROVEN).flatMap((from) => ["fetch", "XMLHttpRequest"].map((how) => ({ from, how, method: "GET", url: `${port}/json/version?${from}-${how}` })));
  const leave = ["sendBeacon", "keepalive"].map((how) => ({ from: "page", how, method: "POST", url: `${origin}/app/?control-${how}` }));
  return [...cross, ...leave];
}

/** The pagehide listener for the two leave attempts. Both go to this origin, which the policy allows. */
function onLeave(origin) {
  const beacon = `${origin}/app/?control-sendBeacon`;
  const keep = `${origin}/app/?control-keepalive`;
  return `addEventListener("pagehide", () => { navigator.sendBeacon(${JSON.stringify(beacon)}, "x"); fetch(${JSON.stringify(keep)}, { method: "POST", body: "x", keepalive: true }); })`;
}

/**
 * The default agent keeps the socket open, which holds the process after the run ends.
 * @param {URL} url
 * @returns {Promise<{ status: number, rawHeaders: string[], body: string }>}
 */
function getResponse(url) {
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** @param {URL} current @param {string[]} rawHeaders @returns {URL | null} */
function redirectTarget(current, rawHeaders) {
  let location = "";
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (location || String(rawHeaders[i]).toLowerCase() !== "location") continue;
    location = String(rawHeaders[i + 1]).trim();
  }
  if (!location) return null;
  let next;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") return null;
  return next;
}

/** Enforcing Content-Security-Policy header policies. Chrome splits one field on commas. */
function policyHeaders(rawHeaders) {
  let count = 0;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() !== "content-security-policy") continue;
    for (const token of String(rawHeaders[i + 1]).split(",")) {
      if (token.trim() !== "") count += 1;
    }
  }
  return count;
}

/**
 * Enforcing Content-Security-Policy meta elements in the document head.
 * Chrome ignores a meta tag in a script, a style, or outside the head.
 */
function policyMetas(html) {
  const source = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const lower = source.toLowerCase();
  let inHead = false;
  let raw = "";
  let count = 0;
  let cursor = 0;
  const skipTag = (at) => {
    let quote = "";
    let end = at;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") quote = char;
      else if (char === ">") break;
    }
    return end;
  };
  const boundaryOf = (at, name) => {
    const boundary = source[at + name.length];
    return !boundary || /[\s/>]/.test(boundary);
  };
  while (cursor < source.length) {
    if (raw) {
      const close = lower.indexOf(`</${raw}`, cursor);
      if (close < 0) break;
      if (!boundaryOf(close + 2, raw)) {
        cursor = close + 2;
        continue;
      }
      const end = skipTag(close);
      if (end >= source.length) break;
      raw = "";
      cursor = end + 1;
      continue;
    }
    const next = lower.indexOf("<", cursor);
    if (next < 0) break;
    if (lower.startsWith("<head", next) && boundaryOf(next + 1, "head")) {
      inHead = true;
      const end = skipTag(next);
      if (end >= source.length) break;
      cursor = end + 1;
      continue;
    }
    if (lower.startsWith("</head", next) && boundaryOf(next + 2, "head")) {
      inHead = false;
      const end = skipTag(next);
      if (end >= source.length) break;
      cursor = end + 1;
      continue;
    }
    if (inHead && (lower.startsWith("<script", next) || lower.startsWith("<style", next))) {
      const name = lower.startsWith("<script", next) ? "script" : "style";
      if (boundaryOf(next + 1, name)) {
        raw = name;
        const end = skipTag(next);
        if (end >= source.length) break;
        cursor = end + 1;
        continue;
      }
    }
    if (inHead && lower.startsWith("<meta", next) && boundaryOf(next + 1, "meta")) {
      const end = skipTag(next);
      if (end >= source.length) break;
      const attrs = new Map();
      const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      for (const match of source.slice(next + 5, end).matchAll(pattern)) {
        const name = match[1].toLowerCase();
        if (!attrs.has(name)) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
      }
      const equiv = attrs.get("http-equiv");
      const content = attrs.get("content");
      if (equiv != null && equiv.trim().toLowerCase() === "content-security-policy" && content != null && content.trim() !== "") count += 1;
      cursor = end + 1;
      continue;
    }
    cursor = next + 1;
  }
  return count;
}

/**
 * Enforcing policies on the final response of GET `${origin}/app/`.
 * fetch() joins repeated Content-Security-Policy lines into one value, so the count walks rawHeaders.
 * @param {string} origin
 * @returns {Promise<{ headers: number, metas: number }>}
 */
async function censusPolicies(origin) {
  const redirects = new Set([301, 302, 303, 307, 308]);
  let url = new URL(`${origin}/app/`);
  let response = await getResponse(url);
  for (let followed = 0; redirects.has(response.status) && followed < 5; followed++) {
    const next = redirectTarget(url, response.rawHeaders);
    if (!next) break;
    url = next;
    response = await getResponse(url);
  }
  if (response.status !== 200) fail(`${origin}/app/ answered ${response.status}`);
  return { headers: policyHeaders(response.rawHeaders), metas: policyMetas(response.body) };
}

function policyLine(census) {
  const headers = `${census.headers} header${census.headers === 1 ? "" : "s"}`;
  const metas = `${census.metas} meta tag${census.metas === 1 ? "" : "s"}`;
  return `policy: ${headers}, ${metas}`;
}

function policyGap(found, want, singular, plural) {
  if (found === want) return "";
  const count = Math.abs(found - want);
  const name = count === 1 ? singular : `${count} ${plural}`;
  return found < want ? `missing ${name}` : `extra ${name}`;
}

/** The build this script started has to serve this composition. The report count still comes from the live census. */
function requireComposition(kind, origin, census) {
  const want = BUILDS[kind].policy;
  const problems = [
    policyGap(census.headers, want.headers, "Content-Security-Policy header", "Content-Security-Policy headers"),
    policyGap(census.metas, want.metas, "enforcing meta tag", "enforcing meta tags"),
  ].filter(Boolean);
  if (problems.length) fail(`${origin}/app/ ${problems.join("; ")}`);
}

/** Loads /app/ and makes every attempt in asks(). */
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
}

/**
 * Why this record does not prove the recorder, or null. Every control attempt must leave exactly what
 * CONTROL says, and every other request or refusal in this browser is judged by the rule the application run uses.
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
  // The control requests, matched by URL and method, are the only requests this browser may make off its origin or with a method other than GET.
  const control = new Set(asks(origin).map((item) => `${item.method} ${item.url}`));
  const stray = strays(record.network.filter((entry) => !control.has(`${entry.method} ${entry.url}`)), origin, policies === 0);
  if (stray.length) return `requests that could carry data: ${stray.slice(0, 5).join("; ")}`;
  const controlUrls = new Set(asks(origin).map((item) => item.url));
  const refused = record.violations.filter((entry) => !controlUrls.has(entry.url));
  if (refused.length) return `content policy violations: ${[...new Set(refused.map((entry) => `[${entry.from}] ${entry.directive} ${entry.url}`))].join("; ")}`;
  return null;
}

async function drive(browser, origin, rows) {
  console.log(`browser: ${(await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).Browser}`);
  await browser.size(1360, 1000);
  const started = Date.now();

  // A demonstration sample must not write to storage or replace a setup saved for
  // a file with the same columns. Remembering is at its default in this browser.
  const setupKey = (names) => `bridgekit:setup:${[...names].sort().join("|")}`;
  const seeded = [
    [
      "sku",
      ["year", "sku", "customer", "units", "sales"],
      { periodColumn: "year", grain: "value", unitsColumn: "units", salesColumn: "sales", levels: [{ name: "My products", columns: ["sku"] }], filters: [] },
    ],
    [
      "budget",
      ["period", "product", "units", "sales"],
      { periodColumn: "period", grain: "value", unitsColumn: "units", salesColumn: "sales", levels: [{ name: "My products", columns: ["product"] }], filters: [] },
    ],
  ];
  for (const [name, columns, saved] of seeded) {
    const key = setupKey(columns);
    const value = JSON.stringify(saved);
    await browser.goto(`${origin}/app/`);
    await browser.evalJs(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    const url = `${origin}/app/?sample=${name}`;
    await browser.goto(url);
    try {
      await browser.waitFor("!!document.querySelector('.kpis')", 600);
    } catch (error) {
      fail(`the ${name} sample at ${url} did not load and calculate within 150 s (${error.message})`);
    }
    const stored = JSON.parse(await browser.evalJs("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))"));
    const keys = Object.keys(stored);
    if (keys.length !== 1 || keys[0] !== key) fail(`${name} sample: storage now holds ${JSON.stringify(keys)}, expected only the saved setup`);
    if (stored[key] !== value) fail(`${name} sample: the saved setup for its columns was replaced`);
    await browser.evalJs(`localStorage.removeItem(${JSON.stringify(key)})`);
    console.log(`ok  ${name} sample: keeps the saved setup for its columns and writes nothing while remembering is on`);
  }

  const sample = `${origin}/app/?sample${rows ? "=" + rows : ""}`;
  await browser.goto(sample);
  await browser.waitFor("!!document.querySelector('.kpis')", 600).catch((error) => fail(`the sample at ${sample} did not load and calculate within 150 s (${error.message})`));
  console.log(`sample loaded and calculated in ${Date.now() - started} ms`);

  const bridgeRowsJs = "JSON.stringify([...document.querySelectorAll('.bridge table')[0].rows].slice(1).map((row) => ({ label: (row.cells[0] ? row.cells[0].innerText : '').trim(), amount: row.cells[1] ? row.cells[1].innerText : '' })))";
  const bridgeTotals = async (step) => {
    const rows = JSON.parse(await browser.evalJs(bridgeRowsJs));
    const amounts = rows.map((row) => parseBridgeAmount(row.amount, `${step}: ${row.label || "row"}`));
    const [prior, ...effects] = amounts;
    const current = effects.pop();
    const residual = prior + effects.reduce((a, b) => a + b, 0) - current;
    if (Math.abs(residual) > effects.length) fail(`${step}: bridge does not add up (off by ${residual})`);
    return { rows, prior, current };
  };
  const sampleTotals = await bridgeTotals("sample");
  console.log(`bridge adds up: ${sampleTotals.prior} + effects = ${sampleTotals.current}`);

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
  try {
    await browser.waitFor("!document.querySelector('aside') && document.body.innerText.includes('Load a sales file')");
  } catch (error) {
    fail(`Clear data did not reset the tool (${error.message})`);
  }
  console.log("ok  clear data returns to the empty tool");

  // The next file with the same columns opens with the remembered setup, minus filters.
  await loadCsv();
  try {
    await browser.waitFor("document.body.innerText.includes('Restored the setup') && document.querySelectorAll('.values input:checked').length === 0");
  } catch (error) {
    fail(`the remembered setup was not restored without its filters (${error.message})`);
  }
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

  // Each built-in sample has to reach a calculated bridge of its own. Remembering
  // is off here, so these walks also prove that a sample stores nothing.
  for (const [name, check] of [
    ["sku", { label: "Sample data (made-up product sales)", mixes: ["Mix: SKU"], first: "Sales 2025", last: "Sales 2026" }],
    ["budget", { label: "Sample data (made-up budget and actual sales)", mixes: ["Mix: Product"], first: "Sales Budget", last: "Sales Actual" }],
  ]) {
    const url = `${origin}/app/?sample=${name}`;
    await browser.goto(url);
    try {
      await browser.waitFor("!!document.querySelector('.kpis')", 600);
    } catch (error) {
      fail(`the ${name} sample at ${url} did not load and calculate within 150 s (${error.message})`);
    }
    const totals = await bridgeTotals(`${name} sample`);
    const mixes = totals.rows.filter((row) => row.label.startsWith("Mix:")).map((row) => row.label);
    if (mixes.join(",") !== check.mixes.join(",")) {
      fail(`${name} sample: mix lines are ${mixes.join(", ") || "none"}, expected ${check.mixes.join(", ")}`);
    }
    const [first, last] = [totals.rows[0].label, totals.rows.at(-1).label];
    if (first !== check.first || last !== check.last) fail(`${name} sample: bridge runs ${first} to ${last}, expected ${check.first} to ${check.last}`);
    const shown = await browser.evalJs("document.querySelector('.source').textContent.trim()");
    if (!shown.startsWith(check.label)) fail(`${name} sample: source label is ${JSON.stringify(shown)}, expected to start with ${JSON.stringify(check.label)}`);
    console.log(`ok  ${name} sample: ${check.label}, ${totals.rows.length} bridge lines, ${totals.prior} to ${totals.current}`);
  }
  if ((await browser.evalJs("localStorage.length")) !== 1) fail("a sample stored something while remembering is off");
  console.log("ok  samples: sku and budget store nothing while remembering is off");

  const fixtureDir = mkdtempSync(join(tmpdir(), "bridgekit-fixtures-"));
  try {
    const fixtures = await writeFixtures(fixtureDir);
    const nodeQuery = await openDatabase();
    await nodeQuery(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv('${fixtures.csvPath}', header=true)`);
    const fixtureSetup = {
      periodColumn: "sale_date",
      grain: "year",
      unitsColumn: "units",
      salesColumn: "net_sales",
      levels: FIXTURE_LEVELS,
      filters: [],
      newAndDiscontinued: "difference",
    };
    await nodeQuery(viewSql(fixtureSetup));
    const expected = await runBridge(nodeQuery, {
      table: VIEW,
      periodColumn: PERIOD,
      prior: "2024",
      current: "2025",
      unitsColumn: "units",
      salesColumn: "net_sales",
      levels: FIXTURE_LEVELS,
    });
    const expectedAmounts = [
      expected.priorSales,
      ...expected.effects.filter((e) => e.key !== "no_units" || e.value !== 0).map((e) => e.value),
      expected.currentSales,
    ];

    const setDataFile = async (path) => {
      await browser.goto(`${origin}/app/`);
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [path] });
      await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
    };
    const addAttribute = async (column) => {
      await browser.evalJs(`T.set(document.querySelector('select[aria-label="Add attribute"]'), ${JSON.stringify(column)})`);
      try {
        await browser.waitFor(`[...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].some((input) => input.value === ${JSON.stringify(column)})`);
      } catch (error) {
        fail(`attributes: ${column} did not appear (${error.message})`);
      }
    };
    const addFixtureLevels = async () => {
      await addAttribute("design");
      await addAttribute("customer");
    };
    const waitReady = async () => {
      await browser.waitFor("!document.querySelector('button.primary').disabled");
    };
    const calculate = async () => {
      await browser.evalJs("T.btn('Calculate bridge').click()");
      await browser.waitFor("!!document.querySelector('.kpis')");
      await browser.waitFor("!!document.querySelector('.bridge table')");
    };
    const readBridge = async (step) => {
      const rows = JSON.parse(await browser.evalJs(bridgeRowsJs));
      return rows.map((row) => parseBridgeAmount(row.amount, `${step}: ${row.label || "row"}`));
    };
    const sameTotals = (got, want, step) => {
      if (got.length !== want.length) fail(`${step}: ${got.length} bridge rows, expected ${want.length}`);
      got.forEach((value, i) => {
        if (Math.abs(value - want[i]) > 1e-6) fail(`${step}: bridge row ${i} is ${value}, expected ${want[i]}`);
      });
    };

    const totalsByFormat = {};
    // CSV and Excel give the same bridge. Parquet is refused below with one
    // plain sentence before the database sees it, so no extension is fetched.
    for (const [name, path] of [["csv", fixtures.csvPath], ["xlsx", fixtures.xlsxPath]]) {
      await setDataFile(path);
      await addFixtureLevels();
      await waitReady();
      await calculate();
      totalsByFormat[name] = await readBridge(`file paths: ${name}`);
    }
    sameTotals(totalsByFormat.xlsx, totalsByFormat.csv, "file paths: xlsx totals differ from csv");
    sameTotals(totalsByFormat.csv, expectedAmounts, "file paths: csv totals differ from the engine in Node");
    console.log("ok  file paths: csv and xlsx give equal totals matching the engine in Node");

    const pickerAccepts = JSON.parse(
      await browser.evalJs("JSON.stringify([...document.querySelectorAll('input[type=file][accept*=csv]')].map((i) => i.accept))"),
    );
    if (pickerAccepts.some((accept) => accept.includes(".parquet"))) fail("file picker still offers .parquet");
    console.log("ok  file picker: no .parquet in accept");

    await browser.goto(`${origin}/app/`);
    {
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [fixtures.csvPath] });
      await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
    }
    const previewFirst = JSON.parse(
      await browser.evalJs(
        "JSON.stringify([...document.querySelectorAll('.dense tbody tr')].slice(0, 3).map((tr) => tr.cells[0] ? tr.cells[0].innerText.trim() : ''))",
      ),
    );
    if (!previewFirst.length) fail("preview: no rows in the data preview");
    for (const cell of previewFirst) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cell)) fail(`preview: date cell is ${JSON.stringify(cell)}, expected YYYY-MM-DD`);
    }
    console.log(`ok  preview: dates show as ${previewFirst[0]} style dates`);

    const refusedPath = join(fixtureDir, "refused.parquet");
    writeFileSync(refusedPath, "not a parquet file\n");
    await browser.goto(`${origin}/app/`);
    {
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [refusedPath] });
      await browser.waitFor("!!document.querySelector('.error')");
    }
    const parquetError = (await browser.evalJs("document.querySelector('.error').textContent.trim()")).trim();
    if (parquetError !== "Parquet files are not supported. Save the file as CSV or Excel and try again.") {
      fail(`parquet: error is ${JSON.stringify(parquetError)}`);
    }
    console.log("ok  parquet: refused with one plain sentence and no network request in the record");
    await setDataFile(fixtures.csvPath);
    await addFixtureLevels();
    await waitReady();
    await calculate();
    sameTotals(await readBridge("parquet reuse"), totalsByFormat.csv, "parquet: the tool did not stay usable for the next file");
    console.log("ok  parquet: the tool stays usable for the next file");

    const pasteTsv = toTsvText(FIXTURE_HEADER, fixtures.rows);
    await browser.goto(`${origin}/app/`);
    await browser.evalJs(
      `(async () => { const text = ${JSON.stringify(pasteTsv)}; const data = { getData: (t) => (t === "text/plain" ? text : "") }; const event = new Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(event, "clipboardData", { value: data }); document.body.dispatchEvent(event); })()`,
    );
    await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
    await addFixtureLevels();
    await waitReady();
    await calculate();
    sameTotals(await readBridge("pasted cells"), totalsByFormat.csv, "pasted cells: totals differ from the csv load");
    console.log("ok  pasted cells: tab-separated text through the paste path gives the same totals");

    await setDataFile(fixtures.formattedPath);
    await addAttribute("product");
    await waitReady();
    await calculate();
    const formatted = await readBridge("formatted numbers");
    const [formattedPrior, ...formattedRest] = formatted;
    const formattedCurrent = formattedRest.pop();
    if (Math.abs(formattedPrior - FORMATTED_PRIOR) > 1e-6) fail(`formatted numbers: prior is ${formattedPrior}, expected ${FORMATTED_PRIOR}`);
    if (Math.abs(formattedCurrent - FORMATTED_CURRENT) > 1e-6) fail(`formatted numbers: current is ${formattedCurrent}, expected ${FORMATTED_CURRENT}`);
    console.log("ok  formatted numbers: 1,234.50, dollar, thousands and parentheses load with the right total");

    await setDataFile(fixtures.csvPath);
    await addFixtureLevels();
    await browser.evalJs(`T.set(T.sel('Compare by'), 'ytd')`);
    const ytdReady = `(() => { const sel = (name) => [...document.querySelectorAll('label')].find((label) => label.firstChild && label.firstChild.textContent.trim().startsWith(name))?.querySelector('select'); const prior = sel('Prior')?.selectedOptions?.[0]; const current = sel('Current')?.selectedOptions?.[0]; return !!prior && !!current && prior.textContent.includes('YTD') && current.textContent.includes('YTD'); })()`;
    await browser.waitFor(ytdReady);
    const ytd = JSON.parse(
      await browser.evalJs(`(() => {
        const sel = (name) => [...document.querySelectorAll('label')].find((label) => label.firstChild && label.firstChild.textContent.trim().startsWith(name))?.querySelector('select');
        const chosen = (name) => { const option = sel(name)?.selectedOptions?.[0]; return option ? { value: option.value, text: option.textContent.trim() } : null; };
        const options = [...document.querySelectorAll('select')].flatMap((select) => [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() }))).filter((option) => option.text.includes('YTD') || option.value.includes('YTD'));
        return JSON.stringify({ options, prior: chosen('Prior'), current: chosen('Current') });
      })()`),
    );
    const visible = ytd.options.map((option) => option.text);
    if (!visible.includes("2024 YTD") || !visible.includes("2025 YTD")) fail(`year to date: period labels are ${visible.join(", ")}`);
    for (const option of ytd.options) {
      if (option.value !== option.text) fail(`year to date: visible label ${JSON.stringify(option.text)} differs from value ${JSON.stringify(option.value)}`);
    }
    if (ytd.prior?.text !== "2024 YTD" || ytd.current?.text !== "2025 YTD") fail(`year to date: selected labels are ${ytd.prior?.text} and ${ytd.current?.text}`);
    await waitReady();
    await calculate();
    console.log("ok  year to date: 2024 YTD and 2025 YTD are the visible period labels and Calculate runs");

    await setDataFile(fixtures.csvPath);
    await addAttribute("customer");
    await addAttribute("design");
    await browser.evalJs(`T.set(T.sel('Sales'), 'units'); T.set(T.sel('Units'), 'net_sales')`);
    const readMapping = async () =>
      JSON.parse(
        await browser.evalJs(`JSON.stringify({ units: T.sel('Units') ? T.sel('Units').value : '', sales: T.sel('Sales') ? T.sel('Sales').value : '', levels: [...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].map((input) => input.value) })`),
      );
    await browser.waitFor(`T.sel('Units')?.value === 'net_sales' && T.sel('Sales')?.value === 'units'`);
    const drafted = await readMapping();
    if (drafted.levels.join(",") !== "customer,design") fail(`load setup: attributes before save are ${drafted.levels.join(", ") || "none"}`);
    const setupJson = await browser.evalJs(`(async () => {
      let blob = null; const original = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return original(b); };
      T.btn('Save setup to file').click();
      for (let i = 0; i < 100 && !blob; i++) await new Promise(r => setTimeout(r, 100));
      URL.createObjectURL = original;
      if (!blob) return "";
      return await blob.text();
    })()`);
    if (!setupJson) fail("load setup: no setup file was saved");
    const saved = JSON.parse(setupJson);
    if (saved.unitsColumn !== "net_sales" || saved.salesColumn !== "units") fail(`load setup: saved mapping is ${saved.unitsColumn}/${saved.salesColumn}`);
    if (!Array.isArray(saved.levels) || saved.levels.map((level) => level.name).join(",") !== "customer,design") fail("load setup: saved attributes are not customer then design");
    const savedSetupPath = join(fixtureDir, "bridgekit-setup.json");
    writeFileSync(savedSetupPath, setupJson);
    await browser.evalJs("T.btn('Clear data').click()");
    await browser.waitFor("!document.querySelector('aside') && document.body.innerText.includes('Load a sales file')");
    await setDataFile(fixtures.csvPath);
    try {
      await browser.waitFor(`T.sel('Units')?.value === 'units' && T.sel('Sales')?.value === 'net_sales' && document.querySelectorAll('.levels li').length === 0`);
    } catch (error) {
      const guessed = await readMapping();
      fail(`load setup: before Load setup the file shows ${guessed.units}/${guessed.sales} and ${guessed.levels.join(", ") || "no attributes"} (${error.message})`);
    }
    {
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type=file][accept*="json"]' });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [savedSetupPath] });
    }
    try {
      await browser.waitFor(`T.sel('Units')?.value === 'net_sales' && T.sel('Sales')?.value === 'units' && [...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].map((input) => input.value).join(',') === 'customer,design'`, 40);
    } catch {
      const got = await readMapping();
      fail(`load setup: mapping is ${got.units}/${got.sales}, attributes ${got.levels.join(", ") || "none"}`);
    }
    console.log("ok  load setup: a saved setup restores a mapping and attribute order the file would not guess");

    await waitReady();
    await calculate();
    const exportBase64 = await browser.evalJs(`(async () => {
      let blob = null; const original = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return original(b); };
      T.btn('Export Excel').click();
      for (let i = 0; i < 400 && !blob; i++) await new Promise(r => setTimeout(r, 200));
      URL.createObjectURL = original;
      if (!blob) return "";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      return btoa(binary);
    })()`);
    if (!exportBase64) fail("exported workbook: no file was exported");
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(exportBase64, "base64"));
    const sheetNames = workbook.worksheets.map((ws) => ws.name);
    for (const name of ["Bridge", "Match coverage", "Price bands", "Setup check", "Setup", "Detail"]) {
      if (!sheetNames.includes(name)) fail(`exported workbook: missing sheet ${name} (has ${sheetNames.join(", ")})`);
    }
    if (!sheetNames.some((name) => name.startsWith("By "))) fail(`exported workbook: no By sheet (has ${sheetNames.join(", ")})`);
    const bridgeSheet = workbook.getWorksheet("Bridge");
    let checkRowNumber = 0;
    bridgeSheet.eachRow((row, number) => {
      if (String(row.getCell(1).value ?? "").startsWith("Check:")) checkRowNumber = number;
    });
    if (!checkRowNumber) fail("exported workbook: no check row on the Bridge sheet");
    const checkCell = bridgeSheet.getRow(checkRowNumber).getCell(2).value;
    const detailSheet = workbook.getWorksheet("Detail");
    if (!detailSheet) fail("exported workbook: no Detail sheet to evaluate the check row from");
    const colIndex = (letters) => {
      let n = 0;
      for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n;
    };
    const rawAt = (sheet, col, row) => sheet.getRow(row).getCell(colIndex(col)).value;
    const byName = (name) => (name === "Detail" ? detailSheet : name === "Bridge" ? bridgeSheet : null);
    const evalFormula = (formula, sheet, col, row, seen = new Set()) => {
      const where = `${sheet.name}!${col}${row}`;
      const bad = (why) => fail(`exported workbook: ${where} formula ${formula}: ${why}`);
      let expression = String(formula).replace(/^=/, "");
      expression = expression.replace(/SUM\(\s*(?:(Detail|Bridge)!)?([A-Z]{1,3})(\d+):(?:(Detail|Bridge)!)?([A-Z]{1,3})(\d+)\s*\)/g, (m, p1, c1, r1, p2, c2, r2) => {
        const name = p1 ?? p2 ?? sheet.name;
        if (c1 !== c2) bad(`cannot evaluate ${m}`);
        const target = byName(name);
        if (!target) bad(`cannot evaluate ${m}`);
        let sum = 0;
        for (let r = Number(r1); r <= Number(r2); r++) sum += numAt(target, c1, r, seen);
        return `(${sum})`;
      });
      expression = expression.replace(/(?:(Detail|Bridge)!)?\b([A-Z]{1,3})(\d+)\b/g, (m, prefix, c, r) => {
        if (m === "SUM" || m === "IF" || m === "CHOOSE") return m;
        if (prefix && prefix !== "Detail" && prefix !== "Bridge") return m;
        const target = prefix ? byName(prefix) : sheet;
        if (!target) bad(`cannot evaluate ${m}`);
        const v = numAt(target, c, Number(r), seen);
        return `(${v})`;
      });
      expression = expression.replace(/<>/g, "!==");
      expression = expression.replace(/(?<![<>=!])=(?!=)/g, "===");
      const IF = (cond, a, b) => (cond ? a : b);
      const CHOOSE = (index, ...choices) => {
        const i = Math.round(Number(index));
        if (!Number.isFinite(i) || i < 1 || i > choices.length) bad(`CHOOSE index ${index} is out of range`);
        return choices[i - 1];
      };
      let computed;
      try {
        computed = Function("IF", "CHOOSE", `"use strict"; return (${expression});`)(IF, CHOOSE);
      } catch (error) {
        if (error instanceof Failure) throw error;
        bad(error instanceof Error ? error.message : String(error));
      }
      if (typeof computed !== "number" || !Number.isFinite(computed)) bad(`evaluates to ${computed}`);
      return computed;
    };
    const numAt = (sheet, col, row, seen = new Set()) => {
      const key = `${sheet.name}!${col}${row}`;
      if (seen.has(key)) fail(`exported workbook: circular reference at ${key}`);
      const v = rawAt(sheet, col, row);
      if (typeof v === "number") return v;
      if (v == null || v === "") return 0;
      if (typeof v === "object" && v !== null && "formula" in v) {
        seen.add(key);
        try {
          const computed = evalFormula(String(v.formula), sheet, col, row, seen);
          if ("result" in v && typeof v.result === "number" && Number.isFinite(v.result) && Math.abs(computed - v.result) > 1e-6) {
            fail(`exported workbook: ${key} formula ${v.formula} evaluates to ${computed}, cached result is ${v.result}`);
          }
          return computed;
        } finally {
          seen.delete(key);
        }
      }
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      fail(`exported workbook: non-numeric ${key} is ${JSON.stringify(v)}`);
    };
    // Number(null) and Number("") are 0, so an empty cell fails here instead of being read as zero.
    function readCheckAmount(value, address) {
      if (value === null || value === undefined) fail(`exported workbook: ${address} is missing`);
      if (value === "") fail(`exported workbook: ${address} is blank`);
      if (typeof value === "number") {
        if (Number.isFinite(value)) return { kind: "number", value };
        fail(`exported workbook: ${address} is not a number`);
      }
      if (typeof value === "object" && typeof value.formula === "string") {
        const cached = typeof value.result === "number" && Number.isFinite(value.result) ? value.result : null;
        return { kind: "formula", formula: value.formula, cached };
      }
      fail(`exported workbook: ${address} is text`);
    }
    const address = `${bridgeSheet.name}!B${checkRowNumber}`;
    const check = readCheckAmount(checkCell, address);
    // The check sums floating-point amounts, so a number and a formula result use one rule.
    // A value within 1e-6 of zero passes. Anything farther fails.
    const nearZero = (value) => Math.abs(value) <= 1e-6;
    const computed = check.kind === "formula" ? evalFormula(check.formula, bridgeSheet, "B", checkRowNumber) : check.value;
    if (!nearZero(computed)) {
      const found = check.kind === "formula" ? `evaluates to ${computed}` : `is ${computed}`;
      fail(`exported workbook: ${address} ${found}, expected a value within 1e-6 of zero`);
    }
    if (check.kind === "formula" && check.cached !== null && !nearZero(check.cached)) {
      fail(`exported workbook: ${address} cached result is ${check.cached}, expected a value within 1e-6 of zero`);
    }
    console.log("ok  exported workbook: sheets present and the Bridge check row is a number or a formula result within 1e-6 of zero");

    await browser.send("Page.enable");
    await browser.send("Page.setInterceptFileChooserDialog", { enabled: true });
    browser.clearFileChoosers();
    const fileControls = JSON.parse(
      await browser.evalJs(`JSON.stringify([...document.querySelectorAll('label.button input[type=file]')].filter(i => i.offsetParent !== null).map(i => ({
        accept: i.accept,
        name: (i.labels && i.labels[0] ? i.labels[0].textContent : "").trim().replace(/\\s+/g, " "),
        inNav: !!i.closest('header nav'),
        inRun: !!i.closest('.run'),
      })))`),
    );
    if (fileControls.length < 2) fail(`keyboard: ${fileControls.length} visible file controls`);
    const tabToInput = async (predicate, step) => {
      await browser.evalJs("if (document.activeElement) document.activeElement.blur()");
      for (let i = 0; i < 40; i++) {
        const active = await browser.evalJs(
          `(() => { const el = document.activeElement; if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return ''; const label = el.labels && el.labels[0] ? el.labels[0].textContent.trim().replace(/\\s+/g, ' ') : ''; return (el.closest('header nav') ? 'nav:' : el.closest('.run') ? 'run:' : 'other:') + label; })()`,
        );
        if (predicate(active)) return;
        await browser.key("Tab");
      }
      fail(`keyboard: Tab did not reach ${step}`);
    };
    const ringJs = (labelExpr) => `(() => {
      const label = ${labelExpr};
      if (!label) return JSON.stringify({ missing: true });
      const style = getComputedStyle(label);
      const backgrounds = [];
      let node = label.parentElement;
      while (node) {
        backgrounds.push(getComputedStyle(node).backgroundColor);
        node = node.parentElement;
      }
      return JSON.stringify({ missing: false, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, boxShadow: style.boxShadow, backgrounds });
    })()`;
    for (const [kind, match, label, labelSel] of [["nav", (s) => s.startsWith("nav:"), "Choose file", "header nav label.button"], ["run", (s) => s.startsWith("run:"), "Load setup", ".run label.button"]]) {
      await browser.evalJs("if (document.activeElement) document.activeElement.blur()");
      await browser.waitFor("!document.activeElement || document.activeElement === document.body || document.activeElement.type !== 'file'");
      const blurred = JSON.parse(await browser.evalJs(ringJs(`document.querySelector(${JSON.stringify(labelSel)})`)));
      await tabToInput(match, label);
      const named = await browser.accessibleName();
      if (named.name !== label) fail(`keyboard: ${kind} control is named ${named.name}`);
      const focused = JSON.parse(await browser.evalJs(ringJs("document.activeElement && document.activeElement.closest('label.button')")));
      const sameRing = blurred.outlineStyle === focused.outlineStyle && blurred.outlineWidth === focused.outlineWidth && blurred.outlineColor === focused.outlineColor && blurred.boxShadow === focused.boxShadow;
      if (!ringVisible(focused) || sameRing) fail(`keyboard: ${label} shows no focus ring (${blurred.outlineStyle} ${blurred.outlineWidth} ${blurred.outlineColor} to ${focused.outlineStyle} ${focused.outlineWidth} ${focused.outlineColor})`);
      for (const key of ["Enter", " "]) {
        browser.clearFileChoosers();
        await browser.key(key);
        try {
          await browser.waitForFileChooser(3000, label);
        } catch (error) {
          fail(`keyboard: ${label} did not open the file chooser on ${key === " " ? "Space" : key} (${error.message})`);
        }
        if (!browser.fileChoosers().length) fail(`keyboard: ${label} did not open the file chooser on ${key === " " ? "Space" : key}`);
      }
    }
    await browser.send("Page.setInterceptFileChooserDialog", { enabled: false });
    console.log("ok  keyboard: Choose file and Load setup are tabbed to, named from the accessibility tree, show a visible focus ring and open on Enter and Space");

    await browser.goto(`${origin}/grouping-level.html`);
    const groupingTitle = await browser.evalJs("document.querySelector('article h1')?.textContent ?? ''");
    if (!groupingTitle.includes("grouping level")) fail(`grouping-level page: ${groupingTitle}`);
    console.log("ok  grouping-level");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Every rule that decides pass or fail for the application's record, over the whole record.
 * @param {Recording} record
 * @param {string} origin
 * @param {{ devServer: boolean }} opts
 * @returns {{ failures: string[], notes: string[] }}
 */
function judge(record, origin, { devServer }) {
  const failures = [];
  const notes = [];
  const leaky = strays(record.network, origin, devServer);
  if (leaky.length) failures.push(`requests that could carry data: ${leaky.slice(0, 5).join("; ")}`);
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
  const census = await censusPolicies(origin);
  console.log(policyLine(census));
  // URL mode cannot tell which policies the server was meant to send. A missing
  // header or meta tag still leaves a positive count, and this mode accepts it.
  // smoke:preview and smoke:wrangler require the composition of the build they started.
  if (target.kind !== "url") requireComposition(target.kind, origin, census);
  const policies = census.headers + census.metas;
  if (policies === 0) console.log(`note: ${origin} sends no content security policy (a dev server). Run npm run build && npm run smoke:preview for the full check.`);
  console.log(`starting ${CHROMIUM}${process.env.CHROMIUM ? "" : " from PATH (set CHROMIUM to start another browser)"}`);
  const control = await recorded((browser) => ask(browser, origin));
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
