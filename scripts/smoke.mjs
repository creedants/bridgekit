//   npm run build            && npm run smoke:preview    (serves dist/ itself)
//   npm run build            && npm run smoke:preview -- --gallery   (rewrites the guide screenshots, their AVIFs and the social card in public/img)
//   npm run build:cloudflare && npm run smoke:wrangler   (local wrangler dev, accounts on)
//   npm run dev   (in another terminal)
//   npm run smoke [-- http://localhost:5173] [rows]
//   CHROMIUM=/path/to/chrome starts that browser. The default is chromium on PATH.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./cdp.mjs";
import { openDatabase } from "../src/duckdb.ts";
import { bridgeBy, runBridge } from "../src/engine.ts";
import { whole, signedWhole } from "../src/app/format.ts";
import { panelTitle } from "../src/app/small-bridges.ts";
import { PERIOD, VIEW, viewSql } from "../src/app/setup.ts";
import {
  FIXTURE_HEADER,
  FIXTURE_LEVELS,
  FORMATTED_CURRENT,
  FORMATTED_PRIOR,
  toCsvText,
  toTsvText,
  writeFixtures,
} from "./smoke-files.mjs";

/** @typedef {{ kind: "preview" } | { kind: "wrangler" } | { kind: "url", origin: string }} Target */
/** @typedef {{ origin: string, stop: () => Promise<void> }} Server */

/** Assigned per run just before the browsers start, so two runs never share a debugging port. */
let DEBUG_PORT = 0;
/** The cross-tab scenario keeps no record, so it opens its own browser beside the recorded ones. */
let SECOND_TAB_PORT = 0;

/** A free loopback port, so two smoke runs on one machine never collide on a hardcoded port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
const CHROMIUM = process.env.CHROMIUM || "chromium";
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name) => join(root, "node_modules/.bin", name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

// The owner decided this sentence. Hardcoded here so the check pins the
// wording users see, not whatever the code happens to hold.
const PARQUET_SENTENCE = "Parquet files are not supported. Save the file as CSV or Excel and try again.";

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
    // The Cloudflare build asks for the session on load, and account routes answer 404
    // unless ACCOUNTS is exactly "on", so this run sets it. LOCAL_EMAIL_LOG logs the
    // sign-in link instead of refusing it. wrangler.jsonc names the production host, so
    // this run overrides BETTER_AUTH_URL. All three are constants and protect nothing.
    command: (dir) => [
      bin("wrangler"), "dev", "--port", devPort(), "--ip", "127.0.0.1", ...local(dir),
      "--var", "ACCOUNTS:on", "--var", "LOCAL_EMAIL_LOG:on", "--var", "BETTER_AUTH_URL:http://localhost:8790",
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
/**
 * The lens the bridge-totals check reads through: prior plus effects minus
 * current, with one unit of tolerance per effect line. The isolated fault
 * case in drive() fails the run when this lens stops seeing an unbalanced
 * bridge, so a neutered assertion cannot pass silently.
 */
function bridgeResidual(amounts) {
  const [prior, ...effects] = amounts;
  const current = effects.pop();
  return prior + effects.reduce((a, b) => a + b, 0) - current;
}

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
 * This scanner handles the explicit head emitted by the repository. Flow
 * content such as a div closes that head, so a later meta is ignored.
 * Chrome can also create an implicit head and enforce its meta policies;
 * this scanner misses those. The build emits an explicit head, and its
 * required policy composition makes unsupported implicit-head pages fail
 * conservatively instead of passing with an incomplete census.
 */
function policyMetas(html) {
  // Elements the parser keeps inside the head. Anything else opens the body
  // and ends the region a meta policy can live in.
  const headContent = new Set(["title", "base", "link", "meta", "style", "script", "noscript", "template"]);
  const tagName = (at) => /^<([A-Za-z0-9]+)/.exec(source.slice(at, at + 16))?.[1].toLowerCase() ?? "";
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
    if (inHead && next + 1 < source.length && source[next + 1] !== "/" && source[next + 1] !== "!") {
      const name = tagName(next);
      if (name && name !== "head" && name !== "html" && !headContent.has(name)) inHead = false;
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

/**
 * A fresh tool page left to settle until its speculative chunk, worker and
 * wasm requests finish, so anything a later file choice adds stands out
 * against it. A cooler page is built below with blocked asset URLs instead:
 * Save-Data emulation cannot switch `navigator.connection.saveData` through
 * this harness, so blocks hold speculative loading off until the choice.
 */
const COLD_SETTLE_MS = 10000;
const COLD_BLOCKED_SETTLE_MS = 4000;
const COLD_BLOCKS = ["*duckdb*", "*Results*", "*.wasm"];

async function coldLoad(browser, origin) {
  await browser.goto(`${origin}/app/`);
  await browser.waitFor("document.body.innerText.includes('Load a sales file')");
  await browser.sleep(COLD_SETTLE_MS);
}

/** A fresh page whose speculative loads are blocked, so nothing loads before the choice. */
async function coldBlockedLoad(browser, origin) {
  await browser.send("Network.setBlockedURLs", { urls: COLD_BLOCKS });
  await browser.goto(`${origin}/app/`);
  await browser.waitFor("document.body.innerText.includes('Load a sales file')");
  await browser.sleep(COLD_BLOCKED_SETTLE_MS);
}

// A checkpoint of every request occurrence, keyed by asker, method and
// address, with multiplicity kept. Two volatile parts of an address are
// normalized so the comparison measures the refusal, not session noise: a
// per-session blob worker address and the ?retry= stamp the chunk retry adds.
const normalizeUrl = (url) =>
  String(url ?? "")
    .replace(/^(blob:[^/]+\/).*$/, "$1<blob>")
    .replace(/([?&]retry=)\d+\.\d+/, "$1<stamp>");

const countRequests = (record) => {
  const counts = new Map();
  for (const entry of record.network) {
    const key = `${entry.from}|${entry.method}|${normalizeUrl(entry.url)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const countByAsker = (record) => {
  const counts = {};
  for (const entry of record.network) counts[entry.from] = (counts[entry.from] ?? 0) + 1;
  return counts;
};

/**
 * The refusal must add no request at all: every key's count in `after` has to
 * equal the checkpoint's count. A repeat of an address the checkpoint already
 * holds fails, which a unique-URL comparison would have accepted.
 */
function assertNoRequestGrowth(before, after, step) {
  const base = countRequests(before);
  const now = countRequests(after);
  const grown = [];
  for (const [key, count] of now) {
    const was = base.get(key) ?? 0;
    if (count > was) grown.push(`${count - was} extra of ${key} (was ${was}, now ${count})`);
  }
  if (grown.length) fail(`${step}: the refusal made requests: ${grown.slice(0, 5).join("; ")}`);
  const missing = [...base].filter(([key, count]) => (now.get(key) ?? 0) < count);
  if (missing.length) {
    fail(`${step}: the refusal twin lost requests the checkpoint held, so the twins are not comparable: ${missing.slice(0, 3).map(([key, count]) => `${key} (was ${count})`).join("; ")}`);
  }
}

const violationKey = (entry) => `${entry.from}|${entry.directive}|${entry.url}`;

function assertNoNewViolations(record, base, step) {
  const known = new Set(base.violations.map(violationKey));
  const extra = record.violations.filter((entry) => !known.has(violationKey(entry)));
  if (extra.length) {
    fail(`${step}: new policy violations: ${extra.slice(0, 3).map((entry) => `[${entry.from}] ${entry.directive} ${entry.url}`).join("; ")}`);
  }
}

function assertAllOrigin(record, origin, step) {
  const stray = record.network.filter((entry) => {
    if (/^(blob|data):/.test(entry.url)) return false;
    const to = URL.canParse(entry.url) ? new URL(entry.url) : null;
    return to?.origin !== origin;
  });
  if (stray.length) fail(`${step}: requests off this origin: ${stray.slice(0, 5).map((e) => `${e.method} ${e.url}`).join("; ")}`);
}

function assertNoThirdPartyExtension(record, step) {
  const ext = record.network.find((entry) => (entry.url || "").includes("extensions.duckdb.org"));
  if (ext) fail(`${step}: asked a third-party host: ${ext.method} ${ext.url}`);
}

async function coldBaseline(browser, origin) {
  await coldLoad(browser, origin);
}

async function coldRefused(browser, origin, parquetPath) {
  await coldLoad(browser, origin);
  const { root } = await browser.send("DOM.getDocument");
  const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
  await browser.send("DOM.setFileInputFiles", { nodeId, files: [parquetPath] });
  await browser.waitFor("!!document.querySelector('.error')");
  const text = (await browser.evalJs("document.querySelector('.error').textContent.trim()")).trim();
  if (text !== PARQUET_SENTENCE) fail(`cold parquet: error is ${JSON.stringify(text)}`);
  console.log("ok  cold parquet: refused with one plain sentence before any database work");
}

async function coldBlockedBaseline(browser, origin) {
  await coldBlockedLoad(browser, origin);
}

async function coldBlocked(browser, origin) {
  await coldBlockedLoad(browser, origin);
  await browser.evalJs(`(async () => {
    const file = new File(["not a parquet file\\n"], "REFUSED.PARQUET", { type: "application/octet-stream" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const event = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dt });
    document.querySelector(".shell").dispatchEvent(event);
  })()`);
  await browser.waitFor("!!document.querySelector('.error')");
  const text = (await browser.evalJs("document.querySelector('.error').textContent.trim()")).trim();
  if (text !== PARQUET_SENTENCE) fail(`blocked parquet: error is ${JSON.stringify(text)}`);
  console.log("ok  blocked parquet: refused with one plain sentence while database assets are unavailable");
}

/**
 * Browser-level download events for the page on `port`, so a click's suggested
 * file name and how many files it started are read from Chromium itself.
 */
async function openDownloadEvents(port, downloadPath) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`download events could not reach the browser on port ${port}`));
  });
  let id = 0;
  const pending = new Map();
  const names = [];
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id) {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.reject(new Error(`${waiter.method} failed: ${data.error.message}`));
      else waiter.resolve(data.result);
      return;
    }
    if (data.method === "Browser.downloadWillBegin") names.push(data.params.suggestedFilename);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, { resolve, reject, method });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath, eventsEnabled: true });
  return { names, close: () => socket.close() };
}

/**
 * Answers the page's next confirm on a second connection, because the page's own evaluation waits while a dialog
 * is open. Resolves with the dialog's message.
 */
async function answerDialog(port, accept, click) {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`dialog events could not reach the page on port ${port}`));
  });
  try {
    const message = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no dialog opened within 5 s")), 5000);
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.method !== "Page.javascriptDialogOpening") return;
        clearTimeout(timer);
        socket.send(JSON.stringify({ id: 2, method: "Page.handleJavaScriptDialog", params: { accept } }));
        resolve(data.params.message);
      };
    });
    socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    await click();
    return await message;
  } finally {
    socket.close();
  }
}

/** Clicks a download button and returns the file it produced as base64. */
async function captureDownload(browser, text) {
  return browser.evalJs(`(async () => {
    let blob = null; const original = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return original(b); };
    const click = () => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click();
    // A save inside the button's own cooldown is dropped without a file, so
    // retry until the cooldown expires.
    const deadline = Date.now() + 120000;
    while (!blob && Date.now() < deadline) {
      click();
      for (let i = 0; i < 6 && !blob; i++) await new Promise(r => setTimeout(r, 200));
    }
    URL.createObjectURL = original;
    if (!blob) return "";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(binary);
  })()`);
}

/** The width and height from a PNG's IHDR chunk. */
function pngSize(base64, where) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || bytes.subarray(1, 4).toString() !== "PNG" || bytes.subarray(12, 16).toString() !== "IHDR") {
    fail(`${where}: no PNG was downloaded`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The split grid in both exports. Captures the no-split sheets and picture,
 * chooses the first Split by column, waits for the grid, and checks the Excel
 * sheet and the picture against it. Setting Split back to None restores the
 * no-split sheets.
 */
async function splitExports(browser, nodeQuery, csvPath, setup) {
  const { default: ExcelJS } = await import("exceljs");
  await browser.evalJs(`T.tab("Bridge")`);
  await browser.waitFor("!!document.querySelector('.bridge .waterfall canvas')");
  const loadWorkbook = async (step) => {
    const base64 = await captureDownload(browser, "Export Excel");
    if (!base64) fail(`${step}: no workbook was exported`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(base64, "base64"));
    return workbook;
  };
  const plainNames = (await loadWorkbook("split exports without a split")).worksheets.map((ws) => ws.name);
  if (plainNames.includes("Small bridges")) fail("split exports: Small bridges is present with no Split by column");
  const plainPng = pngSize(await captureDownload(browser, "Download PNG"), "split exports without a split");
  const column = await browser.evalJs(
    "[...document.querySelectorAll('.split select option')].map((o) => o.value).find((v) => v !== '') ?? ''",
  );
  if (!column) fail("split exports: the Split by select offers no column");
  await browser.evalJs(`T.set(document.querySelector('.split select'), ${JSON.stringify(column)})`);
  await browser.waitFor("document.querySelectorAll('.panels .panel').length > 0 && !/Calculating/.test(document.body.innerText)");
  const panels = JSON.parse(
    await browser.evalJs(
      "JSON.stringify([...document.querySelectorAll('.panels .panel')].map((p) => ({ title: p.querySelector('.panel-title').textContent.trim(), figures: p.querySelector('.panel-figures') ? p.querySelector('.panel-figures').innerText : '' })))",
    ),
  );
  if (!panels.length) fail("split exports: the grid shows no panels");
  const between = await browser.evalJs("document.querySelector('.split .panels + .hint').textContent.trim()");
  // The engine's own split of the same column, on the same file and setup.
  await nodeQuery(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv('${csvPath}', header=true)`);
  await nodeQuery(viewSql(setup));
  const by = await bridgeBy(
    nodeQuery,
    {
      table: VIEW,
      periodColumn: PERIOD,
      prior: "2024",
      current: "2025",
      unitsColumn: setup.unitsColumn,
      salesColumn: setup.salesColumn,
      levels: setup.levels,
    },
    column,
  );
  const expectedTitles = by.panels.map((panel) => panelTitle(panel));
  if (panels.map((p) => p.title).join("|") !== expectedTitles.join("|")) {
    fail(`split exports: the grid shows ${panels.map((p) => p.title).join(", ")}, the engine has ${expectedTitles.join(", ")}`);
  }
  console.log(`ok  split exports: the grid shows ${panels.length} values of ${column}`);
  const workbook = await loadWorkbook("split exports");
  const names = workbook.worksheets.map((ws) => ws.name);
  if (names.at(-1) !== "Small bridges") {
    fail(`split exports: the last sheet is ${JSON.stringify(names.at(-1))}, expected Small bridges (has ${names.join(", ")})`);
  }
  const sheet = workbook.getWorksheet("Small bridges");
  if (sheet.getRow(1).getCell(1).value !== `Split by: ${column}`) {
    fail(`split exports: the Small bridges heading is ${JSON.stringify(sheet.getRow(1).getCell(1).value)}, expected Split by: ${column}`);
  }
  const labels = new Set();
  const numerics = new Set();
  sheet.eachRow((row) => {
    labels.add(String(row.getCell(1).value ?? ""));
    const value = row.getCell(2).value;
    if (typeof value === "number") numerics.add(value);
  });
  for (const panel of panels) {
    if (!labels.has(panel.title)) fail(`split exports: the Small bridges sheet is missing ${JSON.stringify(panel.title)}`);
  }
  let last = "";
  sheet.eachRow((row) => {
    const text = String(row.getCell(1).value ?? "");
    if (text) last = text;
  });
  if (last !== between) fail(`split exports: the sheet between line is ${JSON.stringify(last)}, the page shows ${JSON.stringify(between)}`);
  // One figure matches its panel: a figures panel's own numbers, or the first
  // bridged value's prior sales from the engine.
  const figures = panels.find((p) => p.figures);
  if (figures) {
    const amounts = [...figures.figures.matchAll(/-?\d[\d,]*/g)].map((m) => Number(m[0].split(",").join("")));
    if (!amounts.length) fail(`split exports: panel ${JSON.stringify(figures.title)} shows no figure`);
    if (!amounts.some((amount) => numerics.has(amount))) {
      fail(`split exports: panel ${JSON.stringify(figures.title)} shows ${amounts.join(", ")}, none in the Small bridges sheet`);
    }
  } else {
    const first = by.panels.find((panel) => panel.result);
    if (!first) fail("split exports: the engine bridged no value of the split column");
    if (!numerics.has(first.result.priorSales)) {
      fail(`split exports: the Small bridges sheet is missing the prior sales of ${JSON.stringify(panelTitle(first))}`);
    }
  }
  console.log("ok  split exports: the Small bridges sheet holds every value title and one matching figure");
  const splitPng = pngSize(await captureDownload(browser, "Download PNG"), "split exports");
  if (!(splitPng.height > plainPng.height)) {
    fail(`split exports: the picture with the grid is ${splitPng.width}x${splitPng.height}, no taller than ${plainPng.width}x${plainPng.height} without it`);
  }
  console.log(`ok  split exports: the picture grows from ${plainPng.height} to ${splitPng.height} px tall with the grid below it`);
  await browser.evalJs("T.set(document.querySelector('.split select'), '')");
  await browser.waitFor("!document.querySelector('.panels')");
  const restored = (await loadWorkbook("split exports after reset")).worksheets.map((ws) => ws.name);
  if (restored.join("|") !== plainNames.join("|")) {
    fail(`split exports: sheets after reset are ${restored.join(", ")}, expected ${plainNames.join(", ")}`);
  }
  console.log("ok  split exports: setting Split back to None restores the no-split sheets");
}

/**
 * A paste that lands before the first workspace asks nothing. The check starts
 * the sample itself, so the confirm recorder and the paste trigger are in place
 * before the named phase begins. The trigger fires on the first sight of the
 * phase text and survives into the next phase.
 */
async function pendingPaste(browser, origin) {
  const tsv = "period\tproduct\tregion\tunits\tsales\n2025\tA-100\tNorth\t100\t1000\n2026\tA-100\tNorth\t110\t1210\n2026\tB-200\tNorth\t50\t550\n";
  for (const [name, phaseText] of [
    ["preview query", "Making the sample data"],
    ["calculating sample", "Calculating the sample bridge"],
  ]) {
    await browser.goto(`${origin}/app/`);
    await browser.waitFor("T.btn('Use sample data') && !T.btn('Use sample data').disabled", 40);
    await browser.evalJs(`(() => {
      window.__asked = [];
      window.confirm = (message) => { window.__asked.push(message); return true; };
      window.__pasted = false;
      window.__observer = new MutationObserver(() => {
        if (window.__pasted || !document.body.innerText.includes(${JSON.stringify(phaseText)})) return;
        window.__pasted = true;
        const data = { getData: (t) => (t === "text/plain" ? ${JSON.stringify(tsv)} : "") };
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: data });
        document.body.dispatchEvent(event);
      });
      window.__observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    await browser.evalJs("T.btn('Use sample data').click()");
    try {
      await browser.waitFor("window.__pasted === true && document.querySelector('.source')?.textContent.includes('Pasted cells')", 600);
    } catch {
      fail(`pending paste: the paste never landed during the ${name} phase`);
    }
    const asked = JSON.parse(await browser.evalJs("JSON.stringify(window.__asked)"));
    if (asked.length) fail(`pending paste: a paste during the ${name} phase asked ${JSON.stringify(asked)}`);
    // A paste is a fresh file load, so the tool lands on the setup form for
    // the pasted cells, not on a calculated bridge.
    await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.error')");
    console.log(`ok  pending paste: a paste during the ${name} phase asks nothing and loads`);
  }
}

/**
 * T471: a paste made while a ?sample link still waits to start its own load is
 * the visitor's choice. Frames are held from document start so the paste lands
 * before the deferred timer, then released so the sample load may run.
 */
async function sampleLinkPaste(browser, origin) {
  const tsv = toTsvText(
    ["period", "customer", "units"],
    [
      ["2025", "C0001", 10],
      ["2026", "C0001", 12],
      ["2026", "C0002", 7],
    ],
  );
  await browser.send("Page.enable");
  const { identifier } = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const held = []; const raf = window.requestAnimationFrame.bind(window);
      window.__releaseFrames = () => { window.requestAnimationFrame = raf; for (const f of held.splice(0)) raf(f); };
      window.requestAnimationFrame = (f) => { held.push(f); return 1e6 + held.length; };
      window.__pasteListening = false; const add = window.addEventListener.bind(window);
      window.addEventListener = (type, ...rest) => { if (type === "paste") window.__pasteListening = true; return add(type, ...rest); };
    })()`,
  });
  try {
    await browser.goto(`${origin}/app/?sample=1000`);
    await browser.waitFor("window.__pasteListening === true", 200);
    await browser.evalJs(`(() => {
      const text = ${JSON.stringify(tsv)};
      const data = { getData: (t) => (t === "text/plain" ? text : "") };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      document.body.dispatchEvent(event);
      window.__releaseFrames();
      return true;
    })()`);
    await browser.waitFor("document.querySelector('.source')?.textContent.includes('Pasted cells.tsv')", 300);
    await sleep(4000);
    const shown = JSON.parse(
      await browser.evalJs(`JSON.stringify({
        caption: document.querySelector(".source")?.textContent ?? "",
        firstRow: [...(document.querySelector("main .dense tbody tr")?.cells ?? [])].map((cell) => cell.textContent),
      })`),
    );
    if (!shown.caption.includes("Pasted cells.tsv")) fail(`sample link paste: the caption reads ${JSON.stringify(shown.caption)}, not the pasted cells`);
    if (!shown.caption.includes("3 rows")) fail(`sample link paste: the caption reads ${JSON.stringify(shown.caption)}, not the paste's 3 rows`);
    if (shown.firstRow.join("|") !== "2025|C0001|10") {
      fail(`sample link paste: the first preview row is ${JSON.stringify(shown.firstRow)}, not the paste's first row`);
    }
    console.log("ok  sample link paste: a paste made before the sample's own load stays on screen");
  } finally {
    await browser.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}

async function drive(browser, origin, rows) {
  console.log(`browser: ${(await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).Browser}`);
  await browser.size(1360, 1000);
  const started = Date.now();

  // A demonstration sample must not write to storage or replace a setup saved for
  // a file with the same columns. A saved setup with no remember choice beside it
  // counts as on, as it does for a visitor from before the choice was stored.
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
    const residual = bridgeResidual(amounts);
    if (Math.abs(residual) > amounts.length - 2) fail(`${step}: bridge does not add up (off by ${residual})`);
    const [prior, ...effects] = amounts;
    const current = effects.pop();
    return { rows, prior, current, amounts };
  };
  const sampleTotals = await bridgeTotals("sample");
  console.log(`bridge adds up: ${sampleTotals.prior} + effects = ${sampleTotals.current}`);
  // Isolated fault case for the totals lens: the sample figures with the
  // current line moved must not add up. A lens that passes this fails the run.
  {
    const moved = [...sampleTotals.amounts.slice(0, -1), sampleTotals.current + sampleTotals.amounts.length];
    if (Math.abs(bridgeResidual(moved)) <= moved.length - 2) fail("bridge totals check would pass a bridge that does not add up");
    console.log("ok  bridge totals check catches an unbalanced bridge");
  }

  // The money tie-out on the Data check tab, read from its own table so a row
  // count can never be mistaken for a money line. Every figure is whole dollars.
  const readTieOut = async (step) => {
    const rows = JSON.parse(
      await browser.evalJs(
        `JSON.stringify([...document.querySelectorAll('table.tieout tr')].map((row) => [row.cells[0].innerText.trim(), row.cells[1].innerText.trim()]))`,
      ),
    );
    if (rows.length !== 6) fail(`${step}: the money tie-out shows ${rows.length} lines, expected six`);
    const amount = (raw, label) => {
      const text = raw.split(",").join("");
      const value = Number(text);
      if (!/^-?\d+$/.test(text) || !Number.isInteger(value)) fail(`${step}: ${label} is ${JSON.stringify(raw)}, expected whole dollars`);
      return value;
    };
    const lines = rows.map(([label, raw]) => ({ label, raw, value: amount(raw, label) }));
    const pick = (pattern) =>
      lines.flatMap((line) => {
        const match = pattern.exec(line.label);
        return match ? [{ ...line, period: match[1] }] : [];
      });
    const inFile = pick(/^(?:Sales|Margin) in file, (.+)$/);
    const excluded = pick(/^Excluded by filters, (.+)$/);
    const inBridge = pick(/^(?:Sales|Margin) in the bridge, (.+)$/);
    if (inFile.length !== 2 || excluded.length !== 2 || inBridge.length !== 2) {
      fail(`${step}: the money tie-out is ${JSON.stringify(rows.map(([label]) => label))}, expected three lines for each of two periods`);
    }
    for (let i = 0; i < 2; i++) {
      if (inFile[i].period !== excluded[i].period || inFile[i].period !== inBridge[i].period) {
        fail(`${step}: the money tie-out lists different periods across its lines`);
      }
      if (inFile[i].value - excluded[i].value !== inBridge[i].value) {
        fail(`${step}: ${inFile[i].period} has ${inFile[i].value} in the file, ${excluded[i].value} excluded and ${inBridge[i].value} in the bridge, which does not tie out`);
      }
    }
    return { lines, inFile, excluded, inBridge };
  };
  // The two KPI figures at the top of the results, in period order.
  const readKpis = async () =>
    JSON.parse(
      await browser.evalJs(
        `JSON.stringify([...document.querySelectorAll('.kpis .kpi')].slice(0, 2).map((kpi) => [kpi.querySelector('.kpi-label').innerText.trim(), kpi.querySelector('.kpi-value').innerText.trim()]))`,
      ),
    );

  // The period a bridge total line names, from "Sales 2025".
  const periodOf = (label) => label.replace(/^(?:Sales|Margin) /i, "");

  const resultsTitle = "Price-volume-mix bridge";
  const visibleHeadingsJs = `JSON.stringify([...document.querySelectorAll('h1')].filter((h) => {
    const style = getComputedStyle(h);
    return h.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }).map((h) => h.textContent.trim()))`;
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
    const headings = JSON.parse(await browser.evalJs(visibleHeadingsJs));
    if (headings.length !== 1 || headings[0] !== resultsTitle) {
      fail(`${tab}: ${headings.length} visible h1 (${JSON.stringify(headings)}), expected exactly one ${JSON.stringify(resultsTitle)}`);
    }
    console.log(`ok  ${tab}`);
  }

  // The loop leaves the Bridge tab selected.
  await browser.send("Emulation.setEmulatedMedia", { media: "print" });
  const onPaper = JSON.parse(await browser.evalJs(visibleHeadingsJs));
  await browser.send("Emulation.setEmulatedMedia", { media: "" });
  if (onPaper.length !== 0) fail(`print: ${onPaper.length} visible h1 (${JSON.stringify(onPaper)}), expected none`);
  console.log("ok  results heading: one visible h1 on every tab, hidden in print");

  // With no filter there is nothing to exclude, and the file's money is the bridge's.
  await browser.evalJs(`T.tab("Data check")`);
  await browser.sleep(300);
  const sampleTie = await readTieOut("sample with no filter");
  const samplePeriods = [periodOf(sampleTotals.rows[0].label), periodOf(sampleTotals.rows.at(-1).label)];
  if (sampleTie.inFile.map((line) => line.period).join(",") !== samplePeriods.join(",")) {
    fail(`sample with no filter: the money tie-out is for ${sampleTie.inFile.map((line) => line.period).join(", ")}, expected ${samplePeriods.join(", ")}`);
  }
  if (sampleTie.excluded.some((line) => line.value !== 0)) {
    fail(`sample with no filter: the money tie-out excludes ${sampleTie.excluded.map((line) => line.value).join(", ")}, expected zero`);
  }
  const sampleKpis = await readKpis();
  for (const [i, line] of sampleTie.inBridge.entries()) {
    const [kpiLabel, kpiValue] = sampleKpis[i];
    if (periodOf(kpiLabel) !== line.period) {
      fail(`sample with no filter: the KPI for ${line.period} is labelled ${JSON.stringify(kpiLabel)}, expected that period`);
    }
    if (kpiValue !== line.raw) {
      fail(`sample with no filter: the bridge line for ${line.period} is ${line.raw}, expected the KPI figure ${kpiValue}`);
    }
    if (line.value !== sampleTie.inFile[i].value) {
      fail(`sample with no filter: ${line.period} shows ${sampleTie.inFile[i].value} in the file and ${line.value} in the bridge, expected the same figure`);
    }
  }
  console.log("ok  data check: with no filter, nothing is excluded and the file's money is the bridge's");

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

  // The visitor's own file replaces the sample in the address too, so a reload does not bring the sample back.
  await browser.goto(`${origin}/app/?sample`);
  await browser.waitFor("!!document.querySelector('.kpis')", 600);
  await browser.send("DOM.enable");
  const { root } = await browser.send("DOM.getDocument");
  const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
  await browser.send("DOM.setFileInputFiles", { nodeId, files: [new URL("../public/sample-sales.csv", import.meta.url).pathname] });
  await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent && !document.querySelector('.kpis')");
  const addressAfterFile = await browser.evalJs("location.search");
  if (addressAfterFile.includes("sample")) fail(`a file load left the address at ${JSON.stringify(addressAfterFile)}`);
  console.log("ok  a file load drops ?sample from the address");
  const calculateReason = await browser.evalJs("[...document.querySelectorAll('.run .hint')].map((p) => p.textContent.trim()).find((t) => t.startsWith('Choose')) ?? ''");
  if (calculateReason !== "Choose at least one attribute.") fail(`Calculate reason with no attribute is ${JSON.stringify(calculateReason)}`);
  console.log("ok  Calculate names the one missing part");
  await browser.evalJs(`T.set(document.querySelector('select[aria-label="Add attribute"]'), 'model')`);
  await browser.sleep(300);
  await browser.evalJs(`T.set(document.querySelector('select[aria-label="Add filter"]'), 'customer')`);
  await browser.waitFor("document.querySelectorAll('.values input').length > 0");
  await browser.evalJs("document.querySelector('.values input').click()");
  await browser.sleep(800);
  await browser.evalJs("T.btn('Calculate bridge').click()");
  await browser.waitFor("!!document.querySelector('.kpis')");
  await browser.sleep(1500);

  const filteredTotals = await bridgeTotals("sample with a customer filter");
  await browser.evalJs(`T.tab("Data check")`);
  await browser.sleep(300);
  const filteredTie = await readTieOut("sample with a customer filter");
  if (!filteredTie.excluded.some((line) => line.value > 0)) {
    fail(`sample with a customer filter: the money tie-out excludes nothing for ${filteredTie.excluded.map((line) => line.period).join(" or ")}`);
  }
  for (const [i, total] of [filteredTotals.prior, filteredTotals.current].entries()) {
    if (filteredTie.inBridge[i].raw !== whole(total)) {
      fail(`sample with a customer filter: the bridge line for ${filteredTie.inBridge[i].period} is ${filteredTie.inBridge[i].raw}, expected the bridge figure ${whole(total)}`);
    }
  }
  console.log(`ok  data check: with a customer filter, the excluded money (${filteredTie.excluded.map((line) => line.value).join(", ")}) is removed from the file total and the lines tie out`);

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

  // Remembering is off for a fresh visitor, so the sample and this file stored nothing.
  if (Object.keys(stored.localStorage).length) fail(`a fresh visitor's localStorage holds ${JSON.stringify(Object.keys(stored.localStorage))}`);
  console.log("ok  remember setup (default off): stores nothing");

  const rememberBox = "[...document.querySelectorAll('.check input')].find(i => i.closest('label').textContent.includes('Remember'))";

  // Ticking stores the choice and this file's column mapping, with no filter
  // selection or other value from the data.
  if (await browser.evalJs(`${rememberBox}.checked`)) fail("the remember box starts ticked for a fresh visitor");
  await browser.evalJs(`${rememberBox}.click()`);
  await browser.sleep(300);
  const remembered = JSON.parse(await browser.evalJs("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))"));
  const entries = Object.entries(remembered).filter(([key]) => key !== "bridgekit:remember");
  if (remembered["bridgekit:remember"] !== "on" || entries.length !== 1 || !entries[0][0].startsWith("bridgekit:setup:")) {
    fail(`unexpected localStorage after ticking: ${JSON.stringify(Object.keys(remembered))}`);
  }
  for (const [, value] of entries) {
    if (JSON.parse(value).filters.length) fail("a filter selection was stored");
    if (value.includes(`"${selected}"`)) fail("a data value was stored");
  }
  console.log("ok  remember setup: ticking stores the column mapping only");

  const loadCsv = async () => {
    await browser.goto(`${origin}/app/`);
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
    await browser.send("DOM.setFileInputFiles", { nodeId, files: [new URL("../public/sample-sales.csv", import.meta.url).pathname] });
    await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
  };
  const clearClick = () => browser.evalJs("setTimeout(() => T.btn('Clear data').click(), 0)");
  const asked = await answerDialog(DEBUG_PORT, false, clearClick);
  if (asked !== "Clear the loaded data and the bridge?") fail(`Clear data asked ${JSON.stringify(asked)}`);
  await browser.sleep(300);
  if (!(await browser.evalJs("!!document.querySelector('aside')"))) fail("Clear data: Cancel still cleared the data");
  console.log("ok  clear data asks first, and Cancel keeps the data");
  await answerDialog(DEBUG_PORT, true, clearClick);
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

  // Unticking deletes everything stored, and staying off survives a reload.
  await browser.evalJs(`${rememberBox}.click()`);
  await browser.sleep(300);
  const afterOff = await browser.evalJs("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))");
  if (afterOff !== JSON.stringify({})) fail(`opting out left data in localStorage: ${afterOff}`);
  console.log("ok  remember setup: unticking deletes what was stored");

  await loadCsv();
  if (!(await browser.evalJs(`!${rememberBox}.checked && localStorage.length === 0`))) fail("remembering turned itself back on after a reload");
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
  if ((await browser.evalJs("localStorage.length")) !== 0) fail("a sample stored something while remembering is off");
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
      await addAttribute("model");
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
    const STALE_NOTICE = "The setup changed since this bridge was calculated";
    const staleNoticeShown = `document.body.innerText.includes(${JSON.stringify(STALE_NOTICE)})`;
    const omitNamesBox = `[...document.querySelectorAll('.summary label.check input')].find((i) => i.closest('label').textContent.includes('Leave the file name'))`;
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

    // Excel-then-CSV and Excel-then-paste replace the file inside one page
    // and one database instance: the T310 registration drops the last upload
    // before registering the next, so the replacement loads with the same
    // totals instead of failing with "File already registered".
    const setDataFileHere = async (path) => {
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [path] });
      await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
    };
    const pasteHere = async () => {
      const asked = await answerDialog(DEBUG_PORT, true, () => browser.evalJs(
        `(async () => { const text = ${JSON.stringify(toTsvText(FIXTURE_HEADER, fixtures.rows))}; const data = { getData: (t) => (t === "text/plain" ? text : "") }; const event = new Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(event, "clipboardData", { value: data }); document.body.dispatchEvent(event); })()`,
      ));
      if (asked !== "Replace the loaded data with the pasted cells?") fail(`excel-then-paste: the paste asked ${JSON.stringify(asked)}`);
      await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");
    };
    const reloadTotals = async (step, load) => {
      await load();
      try {
        await browser.waitFor(`!!document.querySelector('.error') || !!document.querySelector('select[aria-label="Add attribute"]')`);
      } catch {
        fail(`${step}: the setup never came back after the replacement load`);
      }
      if (await browser.evalJs("!!document.querySelector('.error')")) {
        fail(`${step}: ${(await browser.evalJs("document.querySelector('.error').textContent.trim()")).trim()}`);
      }
      for (const column of ["model", "customer"]) {
        const present = await browser.evalJs(
          `[...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].some((input) => input.value === ${JSON.stringify(column)})`,
        );
        if (!present) await addAttribute(column);
      }
      await waitReady();
      await calculate();
      if (await browser.evalJs("!!document.querySelector('.error')")) {
        fail(`${step}: ${(await browser.evalJs("document.querySelector('.error').textContent.trim()")).trim()}`);
      }
      sameTotals(await readBridge(step), totalsByFormat.csv, `${step}: totals differ from the csv load`);
    };
    await browser.goto(`${origin}/app/`);
    await reloadTotals("excel-then-csv: excel", () => setDataFileHere(fixtures.xlsxPath));
    await reloadTotals("excel-then-csv", () => setDataFileHere(fixtures.csvPath));
    await reloadTotals("excel-then-paste: excel", () => setDataFileHere(fixtures.xlsxPath));
    await reloadTotals("excel-then-paste", pasteHere);
    console.log("ok  excel-then-csv and excel-then-paste: replacements in one page keep the same totals");

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
    if (parquetError !== PARQUET_SENTENCE) {
      fail(`parquet: error is ${JSON.stringify(parquetError)}`);
    }
    console.log("ok  parquet: refused with one plain sentence");
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
    await pendingPaste(browser, origin);
    await sampleLinkPaste(browser, origin);

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

    const readHeads = () => browser.evalJs(
      `JSON.stringify([...document.querySelector('.scroll table thead').rows[0].cells].map((th) => th.textContent.trim()))`,
    ).then(JSON.parse);
    const downloadReport = () => browser.evalJs(`(async () => {
      let blob = null; const original = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return original(b); };
      T.btn('Download report').click();
      for (let i = 0; i < 100 && !blob; i++) await new Promise(r => setTimeout(r, 100));
      URL.createObjectURL = original;
      if (!blob) return "";
      return await blob.text();
    })()`);

    // A sales bridge keeps today literals in Movers and the downloaded report.
    await setDataFile(fixtures.csvPath);
    await addFixtureLevels();
    await waitReady();
    await calculate();
    const salesReport = await downloadReport();
    if (!salesReport) fail("sales labels: no report was downloaded");
    for (const want of ["<title>Sales bridge: 2024 to 2025</title>", "% of prior sales", ">Price</th>"]) {
      if (!salesReport.includes(want)) fail(`sales labels: the report is missing ${JSON.stringify(want)}`);
    }
    if (salesReport.includes("Margin bridge")) fail("sales labels: the report says Margin bridge");
    // Each download button starts one file on a triple click, with the name the browser suggests.
    {
      const downloadDir = join(fixtureDir, "downloads");
      mkdirSync(downloadDir, { recursive: true });
      const events = await openDownloadEvents(DEBUG_PORT, downloadDir);
      try {
        for (const [text, name, tab] of [
          ["Download PNG", "bridge-2024-to-2025.png"],
          ["Download report", "bridge-2024-to-2025.html"],
          ["Save setup to file", "pvm-bridge-setup.json"],
          ["Export Excel", "bridge-2024-to-2025.xlsx"],
          ["CSV", "movers.csv", "Movers"],
          ["All rows", "movers-all-rows.csv", "Movers"],
        ]) {
          if (tab) {
            await browser.evalJs(`T.tab(${JSON.stringify(tab)})`);
            await browser.waitFor("document.querySelectorAll('.dense tbody tr').length > 0");
          }
          events.names.length = 0;
          let at = 0;
          for (const offset of [0, 465, 918]) {
            await browser.sleep(offset - at);
            at = offset;
            // A reasoned click, not a real pointer press: real input would leave the
            // page with user activation, and this harness answers the leave-page
            // dialog only in its own step, so a later file load would hang.
            await browser.evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
          }
          const deadline = Date.now() + 90_000;
          while (!events.names.length && Date.now() < deadline) await browser.sleep(500);
          await browser.sleep(2500);
          if (events.names.length !== 1) fail(`downloads: a triple click on ${text} began ${events.names.length} downloads (${events.names.join(", ") || "none"}), expected one`);
          if (events.names[0] !== name) fail(`downloads: a triple click on ${text} suggested ${JSON.stringify(events.names[0])}, expected ${JSON.stringify(name)}`);
          console.log(`ok  downloads: a triple click on ${text} begins one download named ${name}`);
        }
      } finally {
        events.close();
      }
    }
    await browser.evalJs(`T.tab("Movers")`);
    await browser.sleep(800);
    const salesHeads = await readHeads();
    const salesTail = ["Prior sales", "Current sales", "Change", "Volume", "Mix", "Price", "New configurations", "Discontinued configurations", "No units", "Prior price", "Current price", "Price change"];
    if (salesHeads.slice(-salesTail.length).join("|") !== salesTail.join("|")) {
      fail(`sales labels: Movers headers are ${salesHeads.join(", ")}`);
    }
    console.log("ok  sales labels: Movers and the report keep the sales wording");

    // Check the margin labels in Movers and the report, and omit ignored gross from Setup.
    const marginPath = join(fixtureDir, "margin.csv");
    writeFileSync(marginPath, toCsvText(
      ["period", "product", "units", "gross_sales", "net_sales", "cost"],
      [
        ["2025", "P", 100, 1100, 1000, 400],
        ["2025", "Q", 100, 1200, 1000, 100],
        ["2026", "P", 110, 1331, 1210, 440],
        ["2026", "Q", 90, 990, 900, 135],
      ],
    ));
    await nodeQuery(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv('${marginPath}', header=true)`);
    await nodeQuery(viewSql({ periodColumn: "period", grain: "value", unitsColumn: "units", salesColumn: "net_sales", levels: [{ name: "Product", columns: ["product"] }], filters: [], newAndDiscontinued: "difference" }));
    const marginExpected = await runBridge(nodeQuery, {
      table: VIEW, periodColumn: PERIOD, prior: "2025", current: "2026",
      unitsColumn: "units", salesColumn: "net_sales", costColumn: "cost",
      levels: [{ name: "Product", columns: ["product"] }],
    });
    const marginAmounts = [
      marginExpected.priorSales,
      ...marginExpected.effects.filter((e) => e.key !== "no_units" || e.value !== 0).map((e) => e.value),
      marginExpected.currentSales,
    ];
    await setDataFile(marginPath);
    await addAttribute("product");
    await browser.evalJs(`T.set(T.sel('Cost'), 'cost')`);
    try {
      await browser.waitFor(`T.sel('Cost')?.value === 'cost'`);
    } catch {
      fail("margin labels: the Cost column did not take cost");
    }
    await waitReady();
    await calculate();
    sameTotals(await readBridge("margin bridge"), marginAmounts, "margin bridge: totals differ from the engine in Node");
    console.log(`ok  margin bridge: totals match the engine in Node (prior ${marginAmounts[0]})`);
    const marginReport = await downloadReport();
    if (!marginReport) fail("margin labels: no report was downloaded");
    for (const want of ["<title>Margin bridge: 2025 to 2026</title>", "% of prior margin", "Price and unit cost", "Cost column"]) {
      if (!marginReport.includes(want)) fail(`margin labels: the report is missing ${JSON.stringify(want)}`);
    }
    for (const want of ["Sales bridge", "Gross sales column"]) {
      if (marginReport.includes(want)) fail(`margin labels: the report still says ${JSON.stringify(want)}`);
    }
    console.log("ok  margin labels: the report is a Margin bridge with the cost column and no gross line");
    await browser.evalJs(`T.tab("Movers")`);
    await browser.sleep(800);
    const marginHeads = await readHeads();
    for (const want of ["Price and unit cost", "Prior unit margin", "Current unit margin", "Unit margin change"]) {
      if (!marginHeads.includes(want)) fail(`margin labels: Movers is missing ${JSON.stringify(want)} (has ${marginHeads.join(", ")})`);
    }
    for (const want of ["Prior price", "Current price", "Price change"]) {
      if (marginHeads.includes(want)) fail(`margin labels: Movers still shows ${JSON.stringify(want)}`);
    }
    if (marginHeads.includes("Price")) fail("margin labels: Movers still shows a Price column");
    const marginSort = await browser.evalJs(`(() => { const sel = [...document.querySelectorAll('label')].find((l) => l.firstChild && l.firstChild.textContent.trim().startsWith('Sort by'))?.querySelector('select'); const opt = sel ? [...sel.options].find((o) => o.value === 'price') : null; return opt ? opt.textContent.trim() : ''; })()`);
    if (marginSort !== "Price and unit cost") fail(`margin labels: the price sort is labelled ${JSON.stringify(marginSort)}`);
    const marginHint = await browser.evalJs(`JSON.stringify([...document.querySelectorAll('main .hint')].map((p) => p.textContent.replace(/\\s+/g, " ").trim()).join("\\n"))`).then(JSON.parse);
    for (const want of ["Unit margins exclude sales with no units.", "Unit margin change is the change in average unit margin and includes mix inside the row."]) {
      if (!marginHint.includes(want)) fail(`margin labels: the Movers hint is missing ${JSON.stringify(want)}`);
    }
    if (marginHint.includes("Prices exclude sales with no units.")) fail("margin labels: the Movers hint still talks about prices");
    console.log("ok  margin labels: Movers names the unit-margin figures");
    // The Unit cost bar opens Movers sorted by Price and unit cost. The bar's
    // column is found by its own tooltip label, then clicks sweep that column
    // from top to bottom, so only that bar can answer: any hit opens Movers
    // through its own mapping, and disabling only its mapping fails this check.
    await browser.evalJs(`T.tab("Bridge")`);
    await browser.sleep(800);
    await browser.evalJs("document.querySelector('.bridge .waterfall canvas').scrollIntoView({ block: 'center' })");
    await browser.sleep(300);
    const canvasRect = JSON.parse(
      await browser.evalJs("JSON.stringify(document.querySelector('.bridge .waterfall canvas').getBoundingClientRect().toJSON())"),
    );
    // Park the pointer off the chart so no stale tooltip answers the search.
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasRect.left - 10, y: canvasRect.top - 10 });
    await browser.sleep(300);
    const moverSort = () =>
      browser.evalJs(
        `(() => { const tab = document.querySelector('.tabs [aria-selected="true"]'); const sel = [...document.querySelectorAll('label')].find((l) => l.firstChild && l.firstChild.textContent.trim().startsWith('Sort by'))?.querySelector('select'); return JSON.stringify({ tab: tab ? tab.textContent.trim() : '', sort: sel ? sel.value : '' }); })()`,
      ).then(JSON.parse);
    const tipShowsUnitCost = () =>
      browser.evalJs(
        `(() => { const box = document.querySelector('.bridge .waterfall .chart'); if (!box) return false; return [...box.querySelectorAll('div')].some((d) => { if (!d.innerHTML.includes('<b>Unit cost</b>')) return false; const r = d.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; return parseFloat(getComputedStyle(d).opacity || '1') > 0; }); })()`,
      );
    const sweepHits = async (xs) => {
      const hits = [];
      for (const x of xs) {
        for (const fraction of [0.35, 0.5, 0.65]) {
          const y = canvasRect.top + canvasRect.height * fraction;
          await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await browser.sleep(150);
          if (await tipShowsUnitCost()) {
            hits.push(x);
            break;
          }
        }
      }
      return hits;
    };
    const xs = [];
    for (let i = 0; i < 48; i++) xs.push(canvasRect.left + (canvasRect.width * (i + 0.5)) / 48);
    // Sweep both ways: a tooltip that trails the pointer shifts each run the
    // other way, so only their overlap is the Unit cost slice itself.
    const forward = await sweepHits(xs);
    const backward = await sweepHits([...xs].reverse());
    const lo = Math.max(forward[0] ?? Infinity, backward[backward.length - 1] ?? Infinity);
    const hi = Math.min(forward[forward.length - 1] ?? -Infinity, backward[0] ?? -Infinity);
    if (!(lo <= hi)) fail("unit cost click: the Unit cost bar never showed its tooltip");
    const unitX = (lo + hi) / 2;
    // Hover the middle and confirm it still reads Unit cost before trusting it.
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: unitX, y: canvasRect.top + canvasRect.height / 2 });
    await browser.sleep(300);
    if (!(await tipShowsUnitCost())) fail("unit cost click: the Unit cost bar never showed its tooltip");
    // The open tooltip would eat the clicks, so park the pointer off the
    // chart and let it close before sweeping. The sweep sends no moves.
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvasRect.left - 10, y: canvasRect.top - 10 });
    await browser.sleep(500);
    if (await tipShowsUnitCost()) fail("unit cost click: the Unit cost tooltip never closed before clicking");
    // One column holds one bar: the totals live in their own columns, so any
    // click in this column that opens Movers went through the Unit cost bar.
    let unitCost = null;
    for (let k = 0; k < 40 && !unitCost; k++) {
      const y = canvasRect.top + (canvasRect.height * (k + 0.5)) / 40;
      await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: unitX, y, button: "left", clickCount: 1 });
      await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: unitX, y, button: "left", clickCount: 1 });
      await browser.sleep(400);
      const state = await moverSort();
      if (state.tab === "Movers" && state.sort === "price") {
        unitCost = state;
        break;
      }
      await browser.evalJs(`T.tab("Bridge")`);
      await browser.sleep(400);
    }
    if (!unitCost) fail("unit cost click: clicking the Unit cost bar did not open Movers sorted by Price and unit cost");
    console.log("ok  unit cost click: the Unit cost bar opens Movers sorted by Price and unit cost");

    // The trusted clicks above grant user activation, so this navigation opens
    // the tool's leave-page question. Accept it once; the fresh page starts
    // with no activation. Page.enable wires the dialog up first: without it
    // the dismiss accepts nothing and the navigation still hangs.
    {
      await browser.send("Page.enable");
      const leaving = browser.goto(`${origin}/app/`);
      await browser.sleep(1000);
      await browser.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      await leaving;
      await browser.waitFor("document.body.innerText.includes('Load a sales file')");
    }

    // Zero prior units stay blank in every Movers export, never NaN.
    const zeroUnitsPath = join(fixtureDir, "zero-units.csv");
    writeFileSync(
      zeroUnitsPath,
      toCsvText(
        ["period", "product", "units", "sales"],
        [
          ["2024", "A-100", 0, 0],
          ["2025", "A-100", 10, 1100],
          ["2024", "B-200", 0, 100],
          ["2025", "B-200", 10, 1200],
          ["2024", "C-300", 10, 1000],
          ["2025", "C-300", 10, 1100],
        ],
      ),
    );
    await setDataFile(zeroUnitsPath);
    await addAttribute("product");
    await waitReady();
    await calculate();
    await browser.evalJs(`T.tab("Movers")`);
    await browser.waitFor("document.querySelectorAll('.dense tbody tr').length > 0");
    for (const [button, name] of [["CSV", "movers.csv"], ["All rows", "movers-all-rows.csv"]]) {
      await browser.evalJs(`T.tab("Movers")`);
      await browser.sleep(300);
      const text = Buffer.from(await captureDownload(browser, button), "base64").toString("utf8");
      if (!text) fail(`zero prior units: ${name} produced no file`);
      if (/NaN|Infinity/.test(text)) fail(`zero prior units: ${name} holds ${JSON.stringify(text.match(/NaN|Infinity/)?.[0])}`);
      if (!/,(?=,|$)/m.test(text)) fail(`zero prior units: ${name} has no blank field for the zero-unit row`);
    }
    await browser.evalJs("Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text) => { window.__copiedTsv = text; return Promise.resolve(); } }, configurable: true }); T.btn('Copy').click()");
    await browser.waitFor("typeof window.__copiedTsv === 'string'");
    const copied = await browser.evalJs("window.__copiedTsv");
    if (/NaN|Infinity/.test(copied)) fail("zero prior units: Copy TSV holds NaN or Infinity");
    console.log("ok  zero prior units: Movers CSV, Copy TSV and All rows hold blanks, not NaN");

    await setDataFile(fixtures.csvPath);
    await addFixtureLevels();
    await waitReady();
    await calculate();
    await browser.evalJs(`T.tab("Bridge")`);
    await browser.sleep(800);
    const untickedReport = await downloadReport();
    if (!untickedReport) fail("omit names: no unticked report was downloaded");
    const moverValues = ["MD0", "MD1", "MD2", "MD3"];
    if (!moverValues.some((value) => untickedReport.includes(value))) fail("omit names: the unticked report names no top mover value");
    if (!untickedReport.includes("smoke.csv")) fail("omit names: the unticked report does not name the file");
    const customLabel = "MD0 assortment";
    await browser.evalJs(`T.input(document.querySelectorAll('.levels input[aria-label="Attribute name"]')[0], ${JSON.stringify(customLabel)})`);
    await browser.waitFor(`document.querySelectorAll('.levels input[aria-label="Attribute name"]')[0].value === ${JSON.stringify(customLabel)}`);
    await browser.waitFor(staleNoticeShown);
    await calculate();
    await browser.waitFor(`!(${staleNoticeShown}) && !!document.querySelector('.kpis') && !!document.querySelector('.bridge table')`);
    await browser.evalJs(`T.tab("Bridge")`);
    await browser.sleep(800);
    await browser.evalJs(`(${omitNamesBox}).click()`);
    // The freshness barrier above leaves a new result on screen; the box's
    // own checked state then proves the tick the downloaded report asserts on.
    await browser.waitFor(`${omitNamesBox} && ${omitNamesBox}.checked === true`);
    const tickedReport = await downloadReport();
    if (!tickedReport) fail("omit names: no ticked report was downloaded");
    for (const absent of [...moverValues, "C0", "C1", "C2", "C3", "C4", "smoke.csv", customLabel]) {
      if (tickedReport.includes(absent)) fail(`omit names: the ticked report still names ${JSON.stringify(absent)}`);
    }
    if (tickedReport.toLowerCase().includes(customLabel.toLowerCase())) fail(`omit names: the ticked report still names ${JSON.stringify(customLabel)}`);
    if (tickedReport.includes("<img")) fail("omit names: the ticked report still holds the chart image");
    if (!tickedReport.includes("leaves out the file name, filter values, mover names and chart")) fail("omit names: the ticked report is missing its sentence");
    console.log("ok  omit names: the ticked report leaves mover values, a custom attribute label, the file name and the chart out");

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
    await addAttribute("model");
    await browser.evalJs(`T.set(T.sel('Sales'), 'units'); T.set(T.sel('Units'), 'net_sales')`);
    const readMapping = async () =>
      JSON.parse(
        await browser.evalJs(`JSON.stringify({ units: T.sel('Units') ? T.sel('Units').value : '', sales: T.sel('Sales') ? T.sel('Sales').value : '', levels: [...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].map((input) => input.value) })`),
      );
    await browser.waitFor(`T.sel('Units')?.value === 'net_sales' && T.sel('Sales')?.value === 'units'`);
    const drafted = await readMapping();
    if (drafted.levels.join(",") !== "customer,model") fail(`load setup: attributes before save are ${drafted.levels.join(", ") || "none"}`);
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
    if (!Array.isArray(saved.levels) || saved.levels.map((level) => level.name).join(",") !== "customer,model") fail("load setup: saved attributes are not customer then model");
    const savedSetupPath = join(fixtureDir, "pvm-bridge-setup.json");
    writeFileSync(savedSetupPath, setupJson);
    await answerDialog(DEBUG_PORT, true, () => browser.evalJs("setTimeout(() => T.btn('Clear data').click(), 0)"));
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
      await browser.waitFor(`T.sel('Units')?.value === 'net_sales' && T.sel('Sales')?.value === 'units' && [...document.querySelectorAll('.levels input[aria-label="Attribute name"]')].map((input) => input.value).join(',') === 'customer,model'`, 40);
    } catch {
      const got = await readMapping();
      fail(`load setup: mapping is ${got.units}/${got.sales}, attributes ${got.levels.join(", ") || "none"}`);
    }
    console.log("ok  load setup: a saved setup restores a mapping and attribute order the file would not guess");

    await waitReady();
    await calculate();
    // The Data check tab for the same run, read before the export so the sheet
    // can be compared with it label by label.
    await browser.evalJs(`T.tab("Data check")`);
    await browser.sleep(300);
    const exportTie = await readTieOut("exported workbook");
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
    const setupSheet = workbook.getWorksheet("Setup");
    const moneyRows = [];
    setupSheet.eachRow((row) => {
      const label = String(row.getCell(1).value ?? "");
      if (/^(?:Sales|Margin) in file, |^Excluded by filters, |^(?:Sales|Margin) in the bridge, /.test(label)) {
        moneyRows.push({ label, value: row.getCell(2).value, numFmt: row.getCell(2).numFmt });
      }
    });
    const setupLabels = [
      "Sales in file, 2024", "Excluded by filters, 2024", "Sales in the bridge, 2024",
      "Sales in file, 2025", "Excluded by filters, 2025", "Sales in the bridge, 2025",
    ];
    if (moneyRows.map((row) => row.label).join("|") !== setupLabels.join("|")) {
      fail(`exported workbook: the Setup money tie-out is ${JSON.stringify(moneyRows.map((row) => row.label))}, expected ${JSON.stringify(setupLabels)}`);
    }
    if (moneyRows.length !== exportTie.lines.length) {
      fail(`exported workbook: the Setup money tie-out has ${moneyRows.length} lines, expected the ${exportTie.lines.length} on the Data check tab`);
    }
    for (const [i, row] of moneyRows.entries()) {
      const shown = exportTie.lines[i];
      if (row.label !== shown.label) {
        fail(`exported workbook: Setup money line ${i + 1} is ${JSON.stringify(row.label)}, expected ${JSON.stringify(shown.label)} from the Data check tab`);
      }
      if (row.numFmt !== "#,##0") {
        fail(`exported workbook: Setup money line ${JSON.stringify(row.label)} has number format ${JSON.stringify(row.numFmt)}, expected "#,##0"`);
      }
      if (typeof row.value !== "number" || !Number.isInteger(row.value)) {
        fail(`exported workbook: Setup money line ${JSON.stringify(row.label)} is ${JSON.stringify(row.value)}, expected whole dollars`);
      }
      if (row.value !== shown.value) {
        fail(`exported workbook: Setup money line ${JSON.stringify(row.label)} is ${row.value}, expected ${shown.value} from the Data check tab`);
      }
    }
    for (const i of [0, 1]) {
      const [inFile, excluded, inBridge] = [moneyRows[i * 3].value, moneyRows[i * 3 + 1].value, moneyRows[i * 3 + 2].value];
      if (inFile - excluded !== inBridge) {
        fail(`exported workbook: Setup has ${inFile} in the file, ${excluded} excluded and ${inBridge} in the bridge, which does not tie out`);
      }
      if (excluded !== 0) fail(`exported workbook: Setup excludes ${excluded} with no filter on`);
    }
    console.log("ok  exported workbook: the Setup sheet ties the file's money to the bridge");
    // The description the run was calculated with, pinned word for word. A
    // recomputed description in its place would escape every check above.
    {
      const pinned = [
        ["Source", "smoke.csv"],
        ["Periods", "2024 to 2025 (sale_date, by year)"],
        ["Units column", "net_sales"],
        ["Sales column", "units"],
        ["Attribute 1", "customer (customer)"],
        ["Attribute 2", "model (model)"],
        ["New and discontinued", "price difference only, units in volume"],
      ];
      const described = [];
      setupSheet.eachRow((row) => {
        described.push([String(row.getCell(1).value ?? ""), String(row.getCell(2).value ?? "")]);
      });
      const tieOutAt = described.findIndex(([label]) => label === "Money tie-out");
      const block = (tieOutAt < 0 ? described : described.slice(0, tieOutAt)).filter(([label]) => label !== "");
      if (block.length !== pinned.length || block.some(([label, value], i) => label !== pinned[i][0] || value !== pinned[i][1])) {
        fail(`exported workbook: the Setup description is ${JSON.stringify(block)}, expected ${JSON.stringify(pinned)}`);
      }
      console.log("ok  exported workbook: the Setup sheet pins the run description");
    }
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
    // The load-setup section leaves the swapped mapping and its two levels on
    // screen, so the engine mirrors that run, not the fixture default.
    await splitExports(browser, nodeQuery, fixtures.csvPath, {
      ...fixtureSetup,
      unitsColumn: "net_sales",
      salesColumn: "units",
      levels: [
        { name: "customer", columns: ["customer"] },
        { name: "model", columns: ["model"] },
      ],
    });

    // A stale bridge must not export: the notice and the button describe one
    // fact, the run's signature.
    await setDataFile(fixtures.csvPath);
    await addFixtureLevels();
    await waitReady();
    await calculate();
    const exportButton = `[...document.querySelectorAll('header nav button')].find((b) => b.textContent.trim() === 'Export Excel')`;
    await browser.evalJs(`document.querySelector('button[aria-label="Remove attribute"]').click()`);
    await browser.waitFor(`document.body.innerText.includes(${JSON.stringify(STALE_NOTICE)})`);
    if (!(await browser.evalJs(`${exportButton}.disabled`))) {
      fail("stale bridge: Export Excel stays on while the notice says the setup changed");
    }
    await addAttribute("model");
    await waitReady();
    await calculate();
    try {
      await browser.waitFor(`${exportButton}.disabled === false`, 20000);
    } catch {
      fail("stale bridge: Export Excel stays off after Calculate");
    }
    console.log("ok  stale bridge: Export Excel is off while the setup-changed notice shows, and back after Calculate");

    // A restored or loaded setup must fit the types of the table it lands on.
    const textSalesPath = join(fixtureDir, "text-sales.csv");
    writeFileSync(
      textSalesPath,
      toCsvText(FIXTURE_HEADER, fixtures.rows.map((row) => [row[0], row[1], row[2], row[3], "n/a"])),
    );
    const textMeasurePath = join(fixtureDir, "text-measure-setup.json");
    writeFileSync(
      textMeasurePath,
      JSON.stringify({
        periodColumn: "sale_date",
        grain: "year",
        unitsColumn: "units",
        salesColumn: "net_sales",
        levels: [{ name: "Model", columns: ["model"] }],
        filters: [],
      }),
    );
    const grainPath = join(fixtureDir, "grain-setup.json");
    writeFileSync(
      grainPath,
      JSON.stringify({
        periodColumn: "period",
        grain: "month",
        unitsColumn: "units",
        salesColumn: "sales",
        levels: [{ name: "Product", columns: ["product"] }],
        filters: [],
      }),
    );
    const notJsonPath = join(fixtureDir, "not-a-setup.json");
    writeFileSync(notJsonPath, "{oops");

    const REFUSED = "That setup file does not match the columns in this data.";
    const NOT_SETUP = "That file is not a setup file.";
    const loadSetupFile = async (path) => {
      const { root } = await browser.send("DOM.getDocument");
      const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type=file][accept*="json"]' });
      await browser.send("DOM.setFileInputFiles", { nodeId, files: [path] });
    };
    const errorText = async () =>
      (await browser.evalJs("document.querySelector('.error') ? document.querySelector('.error').textContent.trim() : ''")).trim();
    const noRawText = async (step) => {
      const shown = await errorText();
      for (const trace of ["Binder Error", "strftime(", "sum(", "LINE ", "JSON at position"]) {
        if (shown.includes(trace)) fail(`${step}: the banner reads ${JSON.stringify(shown)}`);
      }
    };

    // Remembering on, so a file with the same columns is offered the saved setup.
    await setDataFile(fixtures.csvPath);
    await browser.evalJs(`${rememberBox}.click()`);
    await browser.sleep(300);
    await addFixtureLevels();
    await waitReady();
    await calculate();
    await setDataFile(textSalesPath);
    await browser.sleep(1200);
    if (await browser.evalJs(`document.body.innerText.includes('Restored the setup')`)) {
      fail("text sales column: the remembered setup was restored onto a table it cannot run");
    }
    if (!(await browser.evalJs("document.querySelector('button.primary').disabled"))) {
      fail("text sales column: Calculate is on with no sales measure");
    }
    if ((await errorText()) !== "") fail(`text sales column: the banner reads ${JSON.stringify(await errorText())}`);
    console.log("ok  text sales column: the remembered setup is dropped, Calculate is off and the banner is empty");

    await loadSetupFile(textMeasurePath);
    await browser.waitFor(`document.querySelector('.error')?.textContent.trim() === ${JSON.stringify(REFUSED)}`, 10000);
    await noRawText("text measure setup");
    if (!(await browser.evalJs("document.querySelector('button.primary').disabled"))) {
      fail("text measure setup: Calculate is on after the refusal");
    }
    console.log("ok  text measure setup: refused with one plain sentence and Calculate stays off");

    await setDataFile(fixtures.formattedPath);
    await loadSetupFile(grainPath);
    await browser.waitFor(`document.querySelector('.error')?.textContent.trim() === ${JSON.stringify(REFUSED)}`, 10000);
    await noRawText("grain setup");
    console.log("ok  grain setup: refused with one plain sentence instead of a database error");

    await loadSetupFile(notJsonPath);
    await browser.waitFor(`document.querySelector('.error')?.textContent.trim() === ${JSON.stringify(NOT_SETUP)}`, 10000);
    await noRawText("not a setup file");
    console.log("ok  not a setup file: one plain sentence instead of a JSON parser message");

    await browser.evalJs(`${rememberBox}.click()`);
    await browser.sleep(300);

    await browser.send("Page.enable");
    await browser.send("Page.setInterceptFileChooserDialog", { enabled: true });
    browser.clearFileChoosers();
    const fileControls = JSON.parse(
      await browser.evalJs(`JSON.stringify([...document.querySelectorAll('label.button input[type=file]')].filter(i => i.offsetParent !== null).map(i => ({
        accept: i.accept,
        name: (i.labels && i.labels[0] ? i.labels[0].textContent : "").trim().replace(/\\s+/g, " "),
        inNav: !!i.closest('header nav'),
        inKeep: !!i.closest('.keep'),
      })))`),
    );
    if (fileControls.length < 2) fail(`keyboard: ${fileControls.length} visible file controls`);
    const tabToInput = async (predicate, step) => {
      await browser.evalJs("if (document.activeElement) document.activeElement.blur()");
      for (let i = 0; i < 40; i++) {
        const active = await browser.evalJs(
          `(() => { const el = document.activeElement; if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return ''; const label = el.labels && el.labels[0] ? el.labels[0].textContent.trim().replace(/\\s+/g, ' ') : ''; return (el.closest('header nav') ? 'nav:' : el.closest('.keep') ? 'keep:' : 'other:') + label; })()`,
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
    for (const [kind, match, label, labelSel] of [["nav", (s) => s.startsWith("nav:"), "Choose file", "header nav label.button"], ["keep", (s) => s.startsWith("keep:"), "Load setup", ".keep label.button"]]) {
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

    // The key presses above gave the page user activation, so leaving a page
    // that holds data opens the leave-page question. Answer it if it shows.
    const leaving = browser.goto(`${origin}/grouping-level.html`);
    await browser.sleep(1000);
    await browser.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    await leaving;
    const groupingTitle = await browser.evalJs("document.querySelector('article h1')?.textContent ?? ''");
    if (!groupingTitle.includes("grouping level")) fail(`grouping-level page: ${groupingTitle}`);
    console.log("ok  grouping-level");

    await excelOfflineRecovery(browser, origin, fixtures);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// T69: Chromium keeps a failed dynamic import failed for that address for the
// life of the page, so both Excel actions have to recover by reading a fresh
// copy of the chunk. The first run makes the chunk fail without the network
// going down at all. The recorded browser check for this ticket covers the
// harder variant, a response cut off mid-transfer, with a server that can drop
// a body it has started sending.
const EXCEL_SENTENCE = "The Excel tools could not load. Check your internet connection and try again.";
const EXCEL_CHUNK = "*exceljs.min-*";
const NET_ONLINE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "none" };
const NET_OFFLINE = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" };
const EXCEL_SOURCE = "document.querySelector('.source')?.textContent?.trim() ?? ''";
const EXCEL_ERROR = "document.querySelector('.error')?.textContent?.trim() ?? null";
/** Keeps every blob the page hands the browser, so the next click's workbook is readable. */
const CAPTURE_WORKBOOKS = `(() => {
  if (!window.__capturedWorkbooks) {
    window.__capturedWorkbooks = true;
    window.__workbooks = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => { window.__workbooks.push(blob); return original(blob); };
  }
  window.__workbooks.length = 0;
  return true;
})()`;

async function chooseDataFile(browser, path) {
  const { root } = await browser.send("DOM.getDocument");
  const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
  await browser.send("DOM.setFileInputFiles", { nodeId, files: [path] });
}

/** A page whose bridge is already calculated, so Export Excel has something to write. */
async function loadCalculatedSample(browser, origin) {
  await browser.goto(`${origin}/app/?sample=budget`);
  await browser.waitFor("!!document.querySelector('.kpis')", 600);
  await browser.sleep(500);
}

/** Clicks Export Excel and waits for that click's own download or error. */
async function clickExport(browser) {
  await browser.evalJs(CAPTURE_WORKBOOKS);
  return JSON.parse(
    await browser.evalJs(`(async () => {
      T.btn('Export Excel').click();
      // The click clears the last error in a React commit, so read the banner only after it.
      await new Promise(r => setTimeout(r, 400));
      for (let i = 0; i < 400 && window.__workbooks.length === 0 && !document.querySelector('.error'); i++) await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({ error: ${EXCEL_ERROR}, bytes: window.__workbooks[0]?.size ?? 0, source: ${EXCEL_SOURCE} });
    })()`),
  );
}

/**
 * T69's browser regression, in a production preview build. The first action
 * makes the Excel chunk fail to load, so the browser caches that import as
 * failed and every later action has to reach the library through a fresh
 * address. The last two runs repeat the plain offline-then-online pair for
 * Export Excel and for an .xlsx load.
 */
async function excelOfflineRecovery(browser, origin, fixtures) {
  await browser.size(1360, 1000);
  await browser.send("Network.setCacheDisabled", { cacheDisabled: true });

  await loadCalculatedSample(browser, origin);
  const sample = await browser.evalJs(EXCEL_SOURCE);
  await browser.send("Network.setBlockedURLs", { urls: [EXCEL_CHUNK] });
  const blocked = await clickExport(browser);
  if (blocked.error !== EXCEL_SENTENCE) fail(`Excel blocked chunk: ${JSON.stringify(blocked.error)}`);
  if (blocked.bytes) fail("Excel blocked chunk: a workbook was produced while the chunk could not load");
  if (blocked.source !== sample) fail(`Excel blocked chunk: the loaded data changed to ${JSON.stringify(blocked.source)}`);
  await browser.send("Network.setBlockedURLs", { urls: [] });
  const recovered = await clickExport(browser);
  if (recovered.error) fail(`Excel blocked chunk: the click after unblocking says ${JSON.stringify(recovered.error)}`);
  if (recovered.bytes < 10_000) fail(`Excel blocked chunk: the click after unblocking wrote ${recovered.bytes} bytes`);
  if (recovered.source !== sample) fail(`Excel blocked chunk: the loaded data changed to ${JSON.stringify(recovered.source)}`);
  await chooseDataFile(browser, fixtures.xlsxPath);
  await browser.waitFor("document.querySelector('.source')?.textContent?.includes('smoke.xlsx')", 240);
  const sheet = JSON.parse(await browser.evalJs(`JSON.stringify({ error: ${EXCEL_ERROR}, source: ${EXCEL_SOURCE} })`));
  if (sheet.error) fail(`Excel blocked chunk: the .xlsx load in the same page says ${JSON.stringify(sheet.error)}`);
  if (!/240 rows/.test(sheet.source)) fail(`Excel blocked chunk: the .xlsx load shows ${JSON.stringify(sheet.source)}`);
  console.log(`ok  Excel blocked chunk: the Excel tools sentence, then the same page exports ${recovered.bytes} bytes and loads smoke.xlsx with no reload`);

  await loadCalculatedSample(browser, origin);
  await browser.send("Network.emulateNetworkConditions", NET_OFFLINE);
  const offlineExport = await clickExport(browser);
  if (offlineExport.error !== EXCEL_SENTENCE) fail(`Excel offline export: ${JSON.stringify(offlineExport.error)}`);
  if (offlineExport.bytes) fail("Excel offline export wrote a workbook");
  await browser.send("Network.emulateNetworkConditions", NET_ONLINE);
  const reconnectedExport = await clickExport(browser);
  if (reconnectedExport.error) fail(`Excel offline export after reconnecting: ${JSON.stringify(reconnectedExport.error)}`);
  if (reconnectedExport.bytes < 10_000) fail(`Excel offline export after reconnecting wrote ${reconnectedExport.bytes} bytes`);
  console.log(`ok  Excel offline export: the sentence offline, then ${reconnectedExport.bytes} bytes from the same click after reconnecting`);

  await loadCalculatedSample(browser, origin);
  const sampleBeforeXlsx = await browser.evalJs(EXCEL_SOURCE);
  await browser.send("Network.emulateNetworkConditions", NET_OFFLINE);
  await chooseDataFile(browser, fixtures.xlsxPath);
  await browser.waitFor("!!document.querySelector('.error')", 240);
  const offlineLoad = JSON.parse(await browser.evalJs(`JSON.stringify({ error: ${EXCEL_ERROR}, source: ${EXCEL_SOURCE} })`));
  if (offlineLoad.error !== EXCEL_SENTENCE) fail(`Excel offline load: ${JSON.stringify(offlineLoad.error)}`);
  if (offlineLoad.source !== sampleBeforeXlsx) fail(`Excel offline load replaced the data with ${JSON.stringify(offlineLoad.source)}`);
  await browser.send("Network.emulateNetworkConditions", NET_ONLINE);
  await chooseDataFile(browser, fixtures.xlsxPath);
  await browser.waitFor("document.querySelector('.source')?.textContent?.includes('smoke.xlsx')", 240);
  const reconnectedLoad = JSON.parse(await browser.evalJs(`JSON.stringify({ error: ${EXCEL_ERROR}, source: ${EXCEL_SOURCE} })`));
  if (reconnectedLoad.error) fail(`Excel offline load after reconnecting: ${JSON.stringify(reconnectedLoad.error)}`);
  if (!/240 rows/.test(reconnectedLoad.source)) fail(`Excel offline load after reconnecting shows ${JSON.stringify(reconnectedLoad.source)}`);
  console.log("ok  Excel offline load: the sentence offline, then smoke.xlsx with 240 rows after reconnecting, no reload");

  await browser.send("Network.emulateNetworkConditions", NET_ONLINE);
}

/**
 * A forward proxy to `origin` that cuts the response body of armed paths
 * mid-transfer: it answers the head with the full length, writes the first
 * chunk, and destroys the socket. vite preview cannot end a body part-way,
 * so the cut-body case loads the app through this proxy instead of the
 * origin directly.
 */
async function startCutProxy(origin, shouldCut) {
  const server = createHttpServer((clientReq, clientRes) => {
    const target = new URL(clientReq.url, origin);
    const cut = shouldCut(target);
    const proxyReq = (target.protocol === "https:" ? httpsGet : httpGet)(target, { agent: false }, (proxyRes) => {
      if (!cut) {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      let cutDone = false;
      proxyRes.on("data", (chunk) => {
        if (cutDone) return;
        cutDone = true;
        clientRes.write(chunk.subarray(0, Math.min(chunk.length, 1024)));
        clientRes.socket.destroy();
      });
      proxyRes.on("end", () => clientRes.end());
      proxyRes.on("error", () => clientRes.socket.destroy());
    });
    proxyReq.on("error", () => clientRes.destroy());
    clientReq.pipe(proxyReq);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * T69's harder variant, committed: the Excel chunk's body is cut off
 * mid-transfer, and the same page recovers through a fresh address with no
 * reload. The proxy cuts the bare import and the retry preflight; the next
 * retry reads straight through.
 */
async function excelCutBody(browser, origin) {
  await browser.size(1360, 1000);
  let cuts = 2;
  const proxy = await startCutProxy(origin, (url) => url.pathname.includes("exceljs.min-") && cuts-- > 0);
  try {
    await browser.goto(`${proxy.origin}/app/?sample=budget`);
    await browser.waitFor("!!document.querySelector('.kpis')", 600);
    await browser.sleep(500);
    await browser.send("Network.setCacheDisabled", { cacheDisabled: true });
    const sample = await browser.evalJs(EXCEL_SOURCE);
    for (const step of ["cut bare import", "cut retry preflight"]) {
      const cut = await clickExport(browser);
      if (cut.error !== EXCEL_SENTENCE) fail(`Excel cut body: ${step}: ${JSON.stringify(cut.error)}`);
      if (cut.bytes) fail(`Excel cut body: ${step}: a workbook was produced while the body was cut`);
      if (cut.source !== sample) fail(`Excel cut body: ${step}: the loaded data changed to ${JSON.stringify(cut.source)}`);
    }
    const recovered = await clickExport(browser);
    if (recovered.error) fail(`Excel cut body: the click after the cuts says ${JSON.stringify(recovered.error)}`);
    if (recovered.bytes < 10_000) fail(`Excel cut body: the click after the cuts wrote ${recovered.bytes} bytes`);
    if (recovered.source !== sample) fail(`Excel cut body: the loaded data changed to ${JSON.stringify(recovered.source)}`);
    console.log(`ok  Excel cut body: the sentence on two truncated bodies, then ${recovered.bytes} bytes through a fresh address with no reload`);
  } finally {
    await proxy.stop();
  }
}

/**
 * A second tab of the browser on this port, driven over its own socket. Both
 * tabs share one browser profile and its localStorage, the way two tabs a user
 * opens do. cdp.mjs drives the first page, so the second tab is opened here.
 */
async function openSecondTab(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`the second tab could not reach the browser on port ${port}`));
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    const waiter = data.id && pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(`${waiter.method} failed: ${data.error.message}`));
    else waiter.resolve(data.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, { resolve, reject, method });
      socket.send(JSON.stringify({ id: current, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  return {
    evaluate,
    waitFor: async (expression, tries = 600) => {
      for (let i = 0; i < tries; i++) {
        try {
          if (await evaluate(expression)) return;
        } catch {}
        await sleep(250);
      }
      throw new Error(`the second tab never showed ${expression}`);
    },
    close: async () => {
      await send("Target.closeTarget", { targetId }).catch(() => {});
      socket.close();
    },
  };
}

/**
 * Two tabs of one browser share localStorage, and each tab's Remember box
 * follows the other's. Page A opens unticked with nothing stored, page B ticks
 * and saves a setup, page A unticks and storage empties, page B ticks again,
 * and page B restores its setup when it loads the same columns after a reload.
 * The same walk runs once with a demonstration sample loaded in page A.
 */
async function rememberAcrossPages(browser, origin, { sample }) {
  const rememberBox = `[...document.querySelectorAll('.check input')].find((input) => input.closest('label').textContent.includes('Remember'))`;
  const readStorage = async () => JSON.parse(await browser.evalJs("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))"));
  const setupKey = (names) => `bridgekit:setup:${[...names].sort().join("|")}`;
  const aHeader = ["year", "product", "units", "sales"];
  const bHeader = ["period", "customer", "units", "sales"];
  const rows = [
    ["2025", "A1", 100, 1000],
    ["2026", "A1", 110, 1210],
    ["2026", "A2", 50, 550],
  ];
  const bRows = [
    ["2025", "C1", 100, 1000],
    ["2026", "C1", 110, 1210],
    ["2026", "C2", 50, 550],
  ];
  const pasteCells = async (evaluate, text) => {
    await evaluate(`(() => {
      const data = { getData: (type) => (type === "text/plain" ? ${JSON.stringify(text)} : "") };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      document.body.dispatchEvent(event);
    })()`);
  };

  const ticked = `!!${rememberBox} && ${rememberBox}.checked`;
  const unticked = `!!${rememberBox} && !${rememberBox}.checked`;

  await browser.goto(sample ? `${origin}/app/?sample=${sample}` : `${origin}/app/`);
  if (sample) {
    await browser.waitFor("!!document.querySelector('aside') && !!document.querySelector('.check input')", 600);
  } else {
    await pasteCells((expression) => browser.evalJs(expression), toTsvText(aHeader, rows));
    await browser.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent", 600);
  }

  // A fresh visitor's page A starts unticked and has stored nothing.
  if (!(await browser.evalJs(unticked))) fail("page A opened with Remember ticked for a fresh visitor");
  const fresh = await readStorage();
  if (Object.keys(fresh).length) fail(`page A stored ${JSON.stringify(Object.keys(fresh))} before Remember was ticked`);

  const tab = await openSecondTab(SECOND_TAB_PORT);
  try {
    // Page B is the second tab: its own app, page A's storage.
    await tab.evaluate(`location.href = ${JSON.stringify(`${origin}/app/`)}`);
    await tab.waitFor("document.body != null && document.body.innerText.includes('Load a sales file')");
    await pasteCells(tab.evaluate, toTsvText(bHeader, bRows));
    await tab.waitFor("!!document.querySelector('aside') && !document.querySelector('.status').textContent");

    // Page B ticks Remember, which stores the choice and the setup it guessed for its columns.
    await tab.evaluate(`${rememberBox}.click()`);
    await tab.waitFor(ticked, 100);
    const onByB = await readStorage();
    if (onByB["bridgekit:remember"] !== "on" || !onByB[setupKey(bHeader)]) {
      fail(`page B ticking Remember left ${JSON.stringify(Object.keys(onByB))}, expected the choice and page B's setup`);
    }

    try {
      await browser.waitFor(ticked, 100);
    } catch (error) {
      fail(`page A did not follow page B to ticked (${error.message})`);
    }

    // Page A unticks, which deletes everything stored, and page B follows.
    await browser.evalJs(`${rememberBox}.click()`);
    await browser.waitFor(unticked, 100);
    const offByA = await readStorage();
    if (Object.keys(offByA).length) fail(`page A unticking Remember left ${JSON.stringify(Object.keys(offByA))}, expected nothing`);
    try {
      await tab.waitFor(unticked, 100);
    } catch (error) {
      fail(`page B did not follow page A to unticked (${error.message})`);
    }

    // Page B ticks again, and page A follows.
    await tab.evaluate(`${rememberBox}.click()`);
    await tab.waitFor(ticked, 100);
    try {
      await browser.waitFor(ticked, 100);
    } catch (error) {
      fail(`page A did not follow page B to ticked the second time (${error.message})`);
    }
    if (!(await readStorage())[setupKey(bHeader)]) fail("page B ticking Remember again saved no setup for its columns");

    // A reloaded tab shows what it restored only after the same file is loaded again.
    await tab.evaluate("location.reload()").catch((error) => {
      if (
        error.message !== "Runtime.evaluate failed: Inspected target navigated or closed" &&
        error.message !== "Runtime.evaluate failed: Execution context was destroyed."
      ) throw error;
    });
    await tab.waitFor("document.body != null && document.body.innerText.includes('Load a sales file')");
    await pasteCells(tab.evaluate, toTsvText(bHeader, bRows));
    try {
      await tab.waitFor("document.body.innerText.includes('Restored the setup')");
    } catch (error) {
      fail(`page B did not restore the setup it saved after reloading (${error.message})`);
    }
  } finally {
    await tab.close();
  }
}

/** Runs the cross-tab walk both ways: page A holds a loaded file, then a demonstration sample. */
async function crossPageRemembering(origin) {
  const failures = [];
  for (const [label, options] of [
    ["remember across tabs", {}],
    ["remember across tabs with a demonstration sample", { sample: "sku" }],
  ]) {
    const browser = await open(SECOND_TAB_PORT, { chromium: CHROMIUM });
    try {
      await rememberAcrossPages(browser, origin, options);
      console.log(`ok  ${label}: Remember starts off, each tab follows the other, and unticking deletes everything${options.sample ? " while a sample is loaded" : ""}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Failure ? error.message : error.stack}`);
    } finally {
      await browser.close();
    }
  }
  if (failures.length) fail(failures.join("\n"));
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

/**
 * avifenc settings for the guide pictures. Speed and one thread are fixed, so the same avifenc writes the same bytes
 * from the same PNG at the same quality. The rest pins colour settings avifenc would otherwise choose, and drops the
 * PNG's colour profile and metadata. Codec selection and other unpinned defaults can still change the files.
 */
const AVIFENC = ["--speed", "6", "--jobs", "1", "--yuv", "444", "--depth", "8", "--range", "full", "--cicp", "1/13/6", "--ignore-icc", "--ignore-exif", "--ignore-xmp"];
/** Qualities tried in turn. Each picture keeps the first that fits its budget, so one busy picture does not blur the rest. */
const AVIF_QUALITIES = [60, 55, 50, 45, 40, 35, 30];

/** The avifenc version line. Fails before the gallery starts a server when avifenc cannot run. @returns {string} */
function avifencVersion() {
  const run = spawnSync("avifenc", ["--version"], { encoding: "utf8" });
  if (run.error?.code === "ENOENT") fail("gallery: avifenc is not on PATH. Install libavif's avifenc (the libavif-bin or libavif package), then run npm run smoke:preview -- --gallery again. No image was changed.");
  if (run.status !== 0) fail(`gallery: avifenc --version failed (${run.error?.message ?? `exit ${run.status}`}). No image was changed.`);
  return run.stdout.split("\n")[0].trim();
}

/** True once Instrument Sans has loaded in the page. A canvas drawn before then keeps fallback metrics. */
const FONT_LOADED = `document.fonts.ready.then(() => [...document.fonts].some((face) => face.family.replaceAll('"', "") === "Instrument Sans" && face.status === "loaded"))`;

/**
 * A served page the pictures start from. `ready` is true once the page shows what every picture of it needs.
 * @typedef {{ path: string, ready: string }} Page
 */
const APP = { path: "/app/?sample", ready: "!!document.querySelector('.kpis') && !!document.querySelector('.bridge table')" };
const HOME = { path: "/", ready: "!!document.querySelector('.hero svg.wf-wide')" };

/**
 * One picture on the site. The gallery loop is its only writer.
 * @typedef {object} Picture
 * @property {string} name  File stem in public/img.
 * @property {Page} page  Loaded once for a run of consecutive pictures of the same page.
 * @property {readonly [number, number]} size  Viewport, device scale 1.
 * @property {(browser: Awaited<ReturnType<typeof open>>) => Promise<void>} show  Brings the loaded page to what this picture shows. Fails on a wrong state.
 * @property {number | null} avifBytes  null: PNG only. Otherwise also writes <name>.avif, which must stay under this size.
 */

/** @returns {Picture["show"]} a show step that opens tab `label` and waits for `ready`. */
const tab = (label, ready) => async (browser) => {
  await browser.evalJs(`T.tab(${JSON.stringify(label)})`);
  await browser.waitFor(ready, 240);
};

/** The movers tab with its first row opened, so the table shows the finish level. @type {Picture["show"]} */
async function openFirstMover(browser) {
  await browser.evalJs(`T.tab("Movers")`);
  await browser.waitFor("document.querySelectorAll('.dense tbody tr.clickable').length > 0", 240);
  await browser.evalJs("document.querySelector('.dense tbody tr.clickable').click()");
  await browser.waitFor("document.querySelector('.dense thead th')?.textContent.trim() === 'finish'", 240);
}

/** The social card's title and dataset line. Beyond the chart's own labels, these are the only words it shows. */
const CARD_HEADER = ["Sales bridge", "2025 to 2026", "Model › Finish › Color › Material"];

/**
 * The parts of the home page the card hides, and the sizes it gives the picture. The hero's own rules do the rest:
 * below the 1240 px breakpoint the picture keeps its corners, window dots and logo, as a 1200 px visitor sees it.
 * The card alone tilts it, and puts it back on the sun band and soft plum shadow it has always had in place of the
 * page's dark stage. The bars stand still. The chart's text grows so its labels still read in a small link preview.
 */
const CARD_CSS = `
  .hero { padding: 0; }
  .hero .hero-grid { max-width: none; padding: 0; }
  .hero .copy, .hero .peek, .hero .kpis, .hero .tabs, .hero .legend { display: none; }
  .hero figure { height: 630px; margin: 0; padding: 0 64px; display: flex; align-items: center; background: var(--sun); box-shadow: none; }
  .hero figure::before { display: none; }
  .hero .frame { width: 100%; max-width: none; transform: rotate(-1.5deg); box-shadow: 0 0 0 1px rgba(66, 32, 61, .10), 0 2px 4px rgba(66, 32, 61, .06), 0 24px 60px -12px rgba(66, 32, 61, .35); }
  .hero .chrome { height: 60px; gap: 1.1rem; padding: 0 1.4rem; }
  .hero .app-name { font-size: 1.25rem; gap: .6rem; }
  .hero .app-name svg { width: 26px; height: 26px; }
  .hero .dataset { font-size: 1.05rem; overflow: visible; }
  .hero .dataset span + span { margin-left: 1.25rem; }
  .hero .body { padding: 1rem 1.5rem 1.25rem; }
  .hero .wf .ax, .hero .wf .cat { font-size: 12.5px; }
  .hero .wf .val { font-size: 13px; }
  .hero .wf rect { animation: none; }
`;

/**
 * Turns the served home page into the social card: hides every body child that does not hold the hero, adds CARD_CSS,
 * and writes CARD_HEADER into the picture's title bar. Runs in the page.
 */
function dressHero([css, title, ...dataset]) {
  const hero = document.querySelector("section.hero");
  for (const child of document.body.children) if (!child.contains(hero)) child.hidden = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  document.querySelector(".hero .app-name").lastChild.data = title;
  document.querySelector(".hero .dataset").replaceChildren(...dataset.map((text) => Object.assign(document.createElement("span"), { textContent: text })));
  return true;
}

/** The visible words beyond `header` and the shown chart's labels, and the ones of them that do not show. Runs in the page. */
function cardWords(header) {
  const extra = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    const text = node.data.trim();
    if (text && node.parentElement.checkVisibility({ opacityProperty: true, visibilityProperty: true })) extra.push(text);
  }
  const labels = [...document.querySelectorAll(".hero svg.wf-wide text")].map((label) => label.textContent.trim());
  const missing = [];
  for (const word of [...header, ...labels]) {
    const at = extra.indexOf(word);
    if (at < 0) missing.push(word);
    else extra.splice(at, 1);
  }
  return { extra, missing };
}

/** @type {Picture["show"]} */
async function heroAsCard(browser) {
  await browser.evalJs(`(${dressHero})(${JSON.stringify([CARD_CSS, ...CARD_HEADER])})`);
  const { extra, missing } = await browser.evalJs(`(${cardWords})(${JSON.stringify(CARD_HEADER)})`);
  const quote = (words) => words.map((word) => JSON.stringify(word)).join(", ");
  if (extra.length) fail(`gallery: the social card shows words beyond today's card: ${quote(extra)}. No image was changed.`);
  if (missing.length) fail(`gallery: the social card does not show ${quote(missing)}. No image was changed.`);
}

const GUIDE = /** @type {const} */ ([1280, 860]);
/**
 * Every picture of the tool on the site, in the order they are taken: opening a mover changes the app's state.
 * Each AVIF budget is its size before the plum look plus about 5%. og-bridge's limit lives in test/sitemap.test.ts.
 * @type {readonly Picture[]}
 */
const PICTURES = [
  { name: "g-bridge", page: APP, size: GUIDE, avifBytes: 54_000, show: tab("Bridge", "!!document.querySelector('.waterfall canvas')") },
  { name: "g-movers", page: APP, size: GUIDE, avifBytes: 40_000, show: openFirstMover },
  { name: "g-price", page: APP, size: GUIDE, avifBytes: 46_000, show: tab("Price changes", "!!document.querySelector('.distribution tbody tr')") },
  { name: "g-setup", page: APP, size: GUIDE, avifBytes: 34_000, show: tab("Setup check", "!!document.querySelector('table.narrow-wide tbody tr')") },
  { name: "og-bridge", page: HOME, size: [1200, 630], avifBytes: null, show: heroAsCard },
];

/**
 * Screenshots the viewport until two shots in a row are byte-equal, then returns those bytes. A still page repeats
 * at once, while an animation, a late font or a redraw shows up as a difference.
 * @returns {Promise<Buffer>}
 */
async function stillShot(browser, name) {
  let last = null;
  for (let shots = 0; shots < 24; shots++) {
    const now = Buffer.from((await browser.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    if (last?.equals(now)) return now;
    last = now;
    await browser.sleep(250);
  }
  fail(`gallery: ${name} kept changing for 6 s (24 screenshots, no two in a row alike): something on the page still moves. No image was changed.`);
}

/** Writes `<dir>/<name>.avif` from the PNG next to it at the best quality under `budget` bytes. @returns {number} the quality */
function encodeAvif(dir, name, budget) {
  const avif = join(dir, `${name}.avif`);
  let bytes = 0;
  for (const quality of AVIF_QUALITIES) {
    const run = spawnSync("avifenc", ["--qcolor", String(quality), ...AVIFENC, join(dir, `${name}.png`), avif], { encoding: "utf8" });
    if (run.status !== 0) fail(`gallery: avifenc could not encode ${name}.png (${run.error?.message ?? `exit ${run.status}`}). No image was changed.\n${`${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-2000)}`);
    bytes = statSync(avif).size;
    if (bytes <= budget) return quality;
  }
  fail(`gallery: ${name}.avif is ${bytes.toLocaleString("en-US")} bytes at quality ${AVIF_QUALITIES.at(-1)}, over its ${budget.toLocaleString("en-US")} budget: the picture changed a lot, so check it and raise its avifBytes in PICTURES in scripts/smoke.mjs. No image was changed.`);
}

/** Copies every staged picture that differs into public/img and prints one row per picture. */
function publish(staged, qualities) {
  const dir = join(root, "public", "img");
  const put = (file) => {
    const bytes = readFileSync(join(staged, file));
    const target = join(dir, file);
    const same = existsSync(target) && readFileSync(target).equals(bytes);
    if (!same) writeFileSync(target, bytes);
    return `${bytes.length.toLocaleString("en-US").padStart(7)} ${same ? "unchanged" : "changed  "}`;
  };
  for (const { name, size, avifBytes } of PICTURES) {
    const avif = avifBytes ? `   avif ${put(`${name}.avif`)}   (quality ${qualities.get(name)}, budget ${avifBytes.toLocaleString("en-US")})` : "";
    console.log(`gallery: ${name.padEnd(9)}  ${size.join("x")}  png ${put(`${name}.png`)}${avif}`);
  }
}

/**
 * Renders every picture into a scratch directory, then publishes them all into public/img. A failure before the
 * publish leaves public/img as it was. The sample is the one the app loads by default, so a rerun repeats the bytes.
 */
async function captureGallery(origin) {
  const staged = mkdtempSync(join(tmpdir(), "bridgekit-gallery-"));
  const qualities = new Map();
  try {
    const browser = await open(DEBUG_PORT, { chromium: CHROMIUM });
    try {
      console.log(`gallery: rendered with ${await browser.evalJs("navigator.userAgent.match(/\\w*Chrome\\/[\\d.]+/)?.[0] ?? navigator.userAgent")}`);
      let page = null;
      for (const picture of PICTURES) {
        await browser.size(...picture.size);
        if (picture.page !== page) {
          await browser.goto(origin + picture.page.path);
          await browser.waitFor(FONT_LOADED, 40);
          await browser.waitFor(picture.page.ready, 600);
          page = picture.page;
        }
        await picture.show(browser);
        const error = await browser.evalJs("T.err()");
        if (error) fail(`gallery: ${picture.name} shows ${JSON.stringify(error)}. No image was changed.`);
        writeFileSync(join(staged, `${picture.name}.png`), await stillShot(browser, picture.name));
        if (picture.avifBytes) qualities.set(picture.name, encodeAvif(staged, picture.name, picture.avifBytes));
      }
    } finally {
      await browser.close();
    }
    publish(staged, qualities);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const gallery = argv.includes("--gallery");
const { target, rows } = parseTarget(argv.filter((arg) => arg !== "--gallery"));
if (gallery) {
  let server = null;
  let failure = null;
  try {
    console.log(`gallery: avifenc ${avifencVersion()}`);
    server = await serve(target);
    await captureGallery(server.origin);
  } catch (error) {
    failure = error;
  } finally {
    await server?.stop().catch((error) => { failure ??= error; });
  }
  if (failure) {
    console.error("FAIL: " + (failure instanceof Failure ? failure.message : failure.stack));
    process.exit(1);
  }
  console.log("gallery images written to public/img");
  process.exit(0);
}
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
  DEBUG_PORT = await freePort();
  SECOND_TAB_PORT = await freePort();
  if (!DEBUG_PORT || !SECOND_TAB_PORT || DEBUG_PORT === SECOND_TAB_PORT) fail(`no two free debugging ports (got ${DEBUG_PORT} and ${SECOND_TAB_PORT})`);
  const control = await recorded((browser) => ask(browser, origin));
  const unproven = proves(control.record, origin, policies);
  if (unproven) fail(`canary: ${unproven}, so a request to another host could go unseen`);
  console.log(`ok  canary: a worker, a shared worker and the page each asked http://127.0.0.1:${DEBUG_PORT} by fetch and by XMLHttpRequest, and each attempt was ${policies ? "refused by the policy and reported" : "recorded and flagged"}`);
  const coldDir = mkdtempSync(join(tmpdir(), "bridgekit-cold-"));
  const coldFailures = [];
  const coldRecords = {};
  try {
    const coldLower = join(coldDir, "refused.parquet");
    writeFileSync(coldLower, "not a parquet file\n");
    for (const [name, steps] of [
      ["baseline", (browser) => coldBaseline(browser, origin)],
      ["refused", (browser) => coldRefused(browser, origin, coldLower)],
      ["blocked baseline", (browser) => coldBlockedBaseline(browser, origin)],
      ["blocked refused", (browser) => coldBlocked(browser, origin)],
    ]) {
      try {
        coldRecords[name] = (await recorded(steps)).record;
      } catch (error) {
        coldFailures.push(`cold ${name}: ${error instanceof Failure ? error.message : error.stack}`);
      }
    }
    const coldCheck = (name, fn) => {
      try {
        fn();
      } catch (error) {
        coldFailures.push(`${name}: ${error instanceof Failure ? error.message : error.stack}`);
      }
    };
    const has = (record, from, file) => record.network.some((entry) => entry.from === from && URL.canParse(entry.url) && file.test(new URL(entry.url).pathname));
    if (coldRecords.baseline && coldRecords.refused) coldCheck("picker parquet", () => {
      // The quiet twin must have finished speculative loading, or equality proves nothing.
      if (!has(coldRecords.baseline, "worker", /\/duckdb-browser-[^/]*\.worker[^/]*\.js$/) || !has(coldRecords.baseline, "worker", /\/duckdb-[^/]*\.wasm$/)) {
        fail("picker baseline: the quiet page never loaded its worker script and wasm, so the comparison proves nothing");
      }
      assertNoRequestGrowth(coldRecords.baseline, coldRecords.refused, "picker parquet");
      assertNoNewViolations(coldRecords.refused, coldRecords.baseline, "picker parquet");
      assertAllOrigin(coldRecords.refused, origin, "picker parquet");
      assertNoThirdPartyExtension(coldRecords.refused, "picker parquet");
      const quiet = countByAsker(coldRecords.baseline);
      const after = countByAsker(coldRecords.refused);
      console.log(`ok  picker record: the refusal added no request (${JSON.stringify(quiet)} to ${JSON.stringify(after)}, ${coldRecords.baseline.network.length} to ${coldRecords.refused.network.length})`);
    });
    if (coldRecords["blocked baseline"] && coldRecords["blocked refused"]) coldCheck("blocked drop parquet", () => {
      // Nothing may have loaded on the blocked twin, or its comparison proves nothing either.
      if (coldRecords["blocked baseline"].askers.some((asker) => asker.kind === "worker" || asker.kind === "shared_worker")) {
        fail("blocked baseline: the blocked page started a worker, so it was never cold");
      }
      assertNoRequestGrowth(coldRecords["blocked baseline"], coldRecords["blocked refused"], "blocked drop parquet");
      assertNoNewViolations(coldRecords["blocked refused"], coldRecords["blocked baseline"], "blocked drop parquet");
      assertAllOrigin(coldRecords["blocked refused"], origin, "blocked drop parquet");
      assertNoThirdPartyExtension(coldRecords["blocked refused"], "blocked drop parquet");
      const quiet = countByAsker(coldRecords["blocked baseline"]);
      const after = countByAsker(coldRecords["blocked refused"]);
      console.log(`ok  blocked drop record: the refusal added no request (${JSON.stringify(quiet)} to ${JSON.stringify(after)}, ${coldRecords["blocked baseline"].network.length} to ${coldRecords["blocked refused"].network.length})`);
    });
  } finally {
    rmSync(coldDir, { recursive: true, force: true, maxRetries: 3 });
  }
  if (coldFailures.length) fail(coldFailures.join("\n"));
  const app = await recorded((browser) => drive(browser, origin, rows));
  const judged = judge(app.record, origin, { devServer: policies === 0 });
  for (const note of judged.notes) console.log(note);
  if (judged.failures.length) fail(judged.failures.join("\n"));
  const excelRequests = app.record.network.filter((entry) => /\/assets\/exceljs\.min-[^/?]+\.js/.test(entry.url));
  const stamped = excelRequests.filter((entry) => /\?retry=\d/.test(entry.url));
  if (!excelRequests.length) fail("Excel offline recovery: no request for the Excel chunk was recorded");
  if (!stamped.length) fail("Excel offline recovery: no stamped retry was recorded, so nothing proves a fresh address was read");
  console.log(`ok  Excel retry: ${stamped.length} of ${excelRequests.length} Excel chunk requests used a stamped address after a failure`);
  await crossPageRemembering(origin);
  // The cut-body case loads the app through a forward proxy, so it runs on
  // its own unrecorded browser after the record closes: the judge would flag
  // the proxy origin as another host.
  {
    const cutBrowser = await open(SECOND_TAB_PORT, { chromium: CHROMIUM });
    try {
      await excelCutBody(cutBrowser, origin);
    } finally {
      await cutBrowser.close();
    }
  }
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
