// Times local wrangler dev routes and writes perf/worker-baseline.json.
// Never passes --remote. Stops the dev server on the way out, including after a failure.
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { arch, cpus, loadavg, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const SAMPLES = 5;
const WARMUP = 1;
const READY_MS = 120_000;
const REQUEST_MS = 120_000;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const CODINGS = [
  { id: "br", header: "br" },
  { id: "gzip", header: "gzip" },
  { id: "identity", header: null },
  { id: "chrome", header: "gzip, deflate, br, zstd" },
];

const root = process.cwd();
const defaultOut = resolve(root, "perf", "worker-baseline.json");
const wranglerBin = join(root, "node_modules", ".bin", "wrangler");

let devChild = null;
let devPort = 0;
let envFile = null;
let authSecret = null;

function die(message) {
  const error = new Error(message);
  error.perf = true;
  throw error;
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) die(`${name} needs a value`);
  return value;
}

function sampleCount() {
  const raw = option("--samples") ?? String(SAMPLES);
  if (!/^\d+$/.test(raw)) die("--samples needs a positive integer");
  const count = Number(raw);
  if (count < 1) die("--samples needs a positive integer");
  return count;
}

function assertFullRun(out, count) {
  if (count !== SAMPLES && resolve(root, out) === defaultOut) {
    die("A partial run cannot write perf/worker-baseline.json. Pass --out to another path.");
  }
}

function localOnly(args) {
  if (args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) die("refusing a --remote wrangler command");
  return args;
}

function series(samples) {
  if (samples.length === 0) die("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { median, min: sorted[0], max: sorted[sorted.length - 1], samples };
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitInfo() {
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const sha = run(["rev-parse", "HEAD"]);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  if (sha.status !== 0) die(sha.stderr);
  return { sha: sha.stdout.trim(), branch: branch.stdout.trim(), porcelain: status.stdout.trim() };
}

function machineInfo() {
  const top = spawnSync("ps", ["-eo", "pcpu,pmem,comm", "--sort=-pcpu"], { encoding: "utf8" });
  const lines = top.stdout ? top.stdout.trim().split("\n").slice(0, 6) : [];
  return {
    cpuModel: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    arch: arch(),
    platform: platform(),
    osRelease: release(),
    node: process.version,
    loadAvg: loadavg(),
    topProcesses: lines,
  };
}

function devPortFromConfig() {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const match = text.match(/"port"\s*:\s*(\d+)/);
  if (!match) die("wrangler.jsonc has no dev.port");
  return Number(match[1]);
}

function listenPids(port) {
  const out = spawnSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8" });
  const ids = new Set();
  const text = `${out.stdout ?? ""}\n${out.stderr ?? ""}`;
  for (const match of text.matchAll(/pid=(\d+)/g)) ids.add(Number(match[1]));
  return [...ids];
}

function devProcesses() {
  const out = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout ?? "";
  const wranglerBinPath = `${root}/node_modules/.bin/wrangler`;
  const wranglerPkg = `${root}/node_modules/wrangler/`;
  return out.split("\n").filter((line) => {
    if (line.includes("scripts/perf/worker.mjs")) return false;
    if (line.includes(wranglerBinPath) || line.includes(wranglerPkg)) return true;
    // argv0 is a path ending in /workerd. A shell that only mentions the word does not match.
    return line.includes(root) && /(?:^|\s)\S+\/workerd(?:\s|$)/.test(line);
  });
}

function printPgrep(label) {
  const lines = devProcesses();
  console.error(`dev processes ${label}\n${lines.join("\n") || "(none)"}`);
}

function exitedWithin(child, ms) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopDev() {
  const child = devChild;
  const port = devPort;
  devChild = null;
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    const stopped = await exitedWithin(child, 4000);
    if (!stopped) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      await exitedWithin(child, 2000);
    }
  }
  if (port) {
    for (const pid of listenPids(port)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await sleep(200);
    const left = listenPids(port);
    if (left.length) die(`port ${port} still has pid ${left.join(", ")}`);
  }
  const leftovers = devProcesses();
  if (leftovers.length) die(`wrangler or workerd still running\n${leftovers.join("\n")}`);
  if (envFile) {
    rmSync(envFile, { force: true });
    envFile = null;
  }
}

function plain(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function scrub(text) {
  const cleaned = plain(text);
  if (!authSecret) return cleaned;
  return cleaned.split(authSecret).join("<redacted>");
}

function writeAuthEnv() {
  const path = `/tmp/bridgekit-perf-worker-${process.pid}.env`;
  authSecret = randomBytes(32).toString("hex");
  writeFileSync(path, `BETTER_AUTH_SECRET=${authSecret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function wasmAssets() {
  const dir = join(root, "dist", "assets");
  if (!existsSync(dir)) die("dist/assets is missing. Run npm run build:cloudflare first.");
  const names = readdirSync(dir).filter((name) => name.endsWith(".wasm.br")).sort();
  if (names.length === 0) die("dist/assets has no .wasm.br files. Run npm run build:cloudflare first.");
  return names.map((name) => {
    const file = name.slice(0, -3);
    const gzPath = join(dir, `${file}.gz`);
    if (!existsSync(gzPath)) die(`missing ${file}.gz next to ${name}`);
    const gz = readFileSync(gzPath);
    return {
      file,
      path: `/assets/${file}`,
      brBytes: statSync(join(dir, name)).size,
      gzBytes: gz.length,
      rawBytes: gunzipSync(gz).length,
    };
  });
}

function buildRoutes(assets) {
  const page = (id, path, note) => ({
    id,
    group: "page",
    method: "GET",
    path,
    accept: "text/html",
    acceptEncoding: null,
    secFetchDest: "document",
    expect: [200],
    body: null,
    stored: null,
    note,
  });
  const counted = "Static HTML. A 200 from the Worker schedules a page-count write. Nothing here reads .dev.vars.";
  const pages = [
    page("page-home", "/", counted),
    page("page-app", "/app/", counted),
    page("page-guide", "/guide.html", "Site links here. Assets html_handling answers with 307 to /guide, which is not in run_worker_first, so the HTML bypasses the Worker and page_views does not rise. totalMs includes the redirect."),
    page("page-method", "/method.html", "Site links here. Assets html_handling answers with 307 to /method, which is not in run_worker_first, so the HTML bypasses the Worker and page_views does not rise. totalMs includes the redirect."),
  ];
  const wasm = [];
  for (const asset of assets) {
    for (const coding of CODINGS) {
      wasm.push({
        id: `wasm-${asset.file}-${coding.id}`,
        group: "wasm",
        method: "GET",
        path: asset.path,
        accept: "*/*",
        acceptEncoding: coding.header,
        secFetchDest: null,
        expect: [200],
        body: null,
        stored: { brBytes: asset.brBytes, gzBytes: asset.gzBytes, rawBytes: asset.rawBytes },
        note: coding.id === "chrome"
          ? "Accept-Encoding lists gzip before br, the order current Chrome sends. Local miniflare can recompress this. It is not an edge measurement."
          : `Accept-Encoding ${coding.header ?? "omitted"}. serveCompressedWasm picks the stored file from this header.`,
      });
    }
  }
  const unauth = (id, method, path, expect, note, body = null) => ({
    id,
    group: id.startsWith("api-config") ? "api" : "unauth",
    method,
    path,
    accept: "application/json",
    acceptEncoding: null,
    secFetchDest: null,
    expect,
    body,
    stored: null,
    note,
  });
  const api = [
    unauth("api-config", "GET", "/api/config", [200], "Public config. No credentials. The auth middleware still constructs Better Auth."),
    unauth(
      "api-workspace-unauth",
      "GET",
      "/api/workspaces/perf-local",
      [403],
      "No session cookie. Expected 403 from the local session check. No remote call.",
    ),
    unauth(
      "api-workspace-post-unauth",
      "POST",
      "/api/workspaces/perf-local/setups",
      [403],
      "No Origin header. Expected 403 before a save. No remote call.",
      "{}",
    ),
    unauth(
      "api-paddle-unauth",
      "POST",
      "/api/paddle/webhook",
      [401],
      "Body {} and no Paddle-Signature. Expected 401. Paddle is not called. The webhook secret is unset in this run.",
      "{}",
    ),
    unauth(
      "api-commentary-unauth",
      "POST",
      "/api/commentary",
      [403],
      "Body {} and no session. Expected 403. The model is not called. ANTHROPIC_API_KEY is unset in this run, so the handler returns before a session read.",
      "{}",
    ),
  ];
  return [...pages, ...wasm, ...api];
}

function byteMatch(bytes, stored) {
  if (!stored) return null;
  if (bytes === stored.brBytes) return "stored-br";
  if (bytes === stored.gzBytes) return "stored-gz";
  if (bytes === stored.rawBytes) return "raw";
  return "other";
}

function safeSnippet(buffer) {
  if (buffer.length > 300) return `${buffer.length} bytes`;
  const text = buffer.toString("utf8");
  if (/secret|api[_-]?key|token|password|authorization/i.test(text)) return `${buffer.length} bytes withheld`;
  return text;
}

function timedRequest(origin, route) {
  const headers = {
    "user-agent": USER_AGENT,
    accept: route.accept,
    connection: "close",
  };
  if (route.acceptEncoding) headers["accept-encoding"] = route.acceptEncoding;
  if (route.secFetchDest) headers["sec-fetch-dest"] = route.secFetchDest;
  if (route.body !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(route.body);
  }
  return new Promise((resolvePromise, reject) => {
    const start = performance.now();
    const req = httpRequest(`${origin}${route.path}`, { method: route.method, headers }, (res) => {
      const ttfbMs = roundMs(performance.now() - start);
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolvePromise({
          status: res.statusCode ?? 0,
          location: String(res.headers.location ?? ""),
          contentType: String(res.headers["content-type"] ?? ""),
          contentEncoding: String(res.headers["content-encoding"] ?? "identity"),
          bytes: body.length,
          byteMatch: byteMatch(body.length, route.stored),
          ttfbMs,
          totalMs: roundMs(performance.now() - start),
          snippet: safeSnippet(body),
        });
      });
    });
    req.setTimeout(REQUEST_MS, () => req.destroy(new Error(`timed out ${route.method} ${route.path}`)));
    req.on("error", reject);
    if (route.body !== null) req.write(route.body);
    req.end();
  });
}

function assertSample(route, sample) {
  if (!route.expect.includes(sample.status)) {
    die(`${route.id} status ${sample.status}, expected ${route.expect.join(" or ")}. body ${sample.snippet}`);
  }
  if (sample.bytes <= 0) die(`${route.id} returned an empty body`);
  if (route.group === "page" && !sample.contentType.includes("text/html")) {
    die(`${route.id} content-type ${sample.contentType || "missing"}`);
  }
  if (route.group === "wasm" && !sample.contentType.includes("application/wasm")) {
    die(`${route.id} content-type ${sample.contentType || "missing"}`);
  }
  if ((route.group === "api" || route.group === "unauth") && !sample.contentType.includes("json")) {
    die(`${route.id} content-type ${sample.contentType || "missing"}`);
  }
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function timedExchange(origin, route) {
  if (route.group !== "page") {
    const sample = await timedRequest(origin, route);
    sample.redirects = [];
    sample.finalPath = route.path;
    return sample;
  }
  const start = performance.now();
  let path = route.path;
  const redirects = [];
  let firstTtfb = null;
  for (let hop = 0; hop < 5; hop++) {
    const sample = await timedRequest(origin, { ...route, path });
    if (firstTtfb === null) firstTtfb = sample.ttfbMs;
    if (!REDIRECT.has(sample.status)) {
      sample.ttfbMs = firstTtfb;
      sample.totalMs = roundMs(performance.now() - start);
      sample.redirects = redirects;
      sample.finalPath = path;
      return sample;
    }
    if (!sample.location) die(`${route.id} redirect ${sample.status} had no Location`);
    const next = new URL(sample.location, `${origin}${path}`);
    if (next.origin !== new URL(origin).origin) die(`${route.id} redirected off origin to ${next.origin}`);
    redirects.push({ status: sample.status, location: `${next.pathname}${next.search}` });
    path = `${next.pathname}${next.search}`;
  }
  die(`${route.id} redirected more than 5 times`);
}

function publishSample(sample) {
  return {
    status: sample.status,
    finalPath: sample.finalPath,
    redirects: sample.redirects,
    contentType: sample.contentType,
    contentEncoding: sample.contentEncoding,
    bytes: sample.bytes,
    byteMatch: sample.byteMatch,
    ttfbMs: sample.ttfbMs,
    totalMs: sample.totalMs,
  };
}

async function timeRoute(origin, route, count, processCold) {
  const coldRaw = await timedExchange(origin, route);
  assertSample(route, coldRaw);
  for (let i = 0; i < WARMUP; i++) {
    const warm = await timedExchange(origin, route);
    assertSample(route, warm);
    if (warm.finalPath !== coldRaw.finalPath) die(`${route.id} final path changed from ${coldRaw.finalPath} to ${warm.finalPath}`);
  }
  const steady = [];
  for (let i = 0; i < count; i++) {
    const sample = await timedExchange(origin, route);
    assertSample(route, sample);
    if (sample.finalPath !== coldRaw.finalPath) die(`${route.id} final path changed from ${coldRaw.finalPath} to ${sample.finalPath}`);
    steady.push(sample);
    console.error(`  ${route.id} ${i + 1}/${count} status ${sample.status} ${sample.contentEncoding} ${sample.bytes} bytes ttfb ${sample.ttfbMs} total ${sample.totalMs} match ${sample.byteMatch ?? "-"}`);
  }
  const statuses = new Set(steady.map((sample) => sample.status));
  if (statuses.size !== 1) die(`${route.id} steady statuses diverged: ${[...statuses].join(", ")}`);
  return {
    id: route.id,
    group: route.group,
    method: route.method,
    path: route.path,
    finalPath: coldRaw.finalPath,
    requestAcceptEncoding: route.acceptEncoding,
    note: route.note,
    expectedStatuses: route.expect,
    stored: route.stored,
    processCold,
    pageCounted: route.group === "page" && route.path === coldRaw.finalPath,
    cold: publishSample(coldRaw),
    steady: {
      status: steady[0].status,
      contentType: steady[0].contentType,
      contentEncoding: steady[0].contentEncoding,
      byteMatch: steady.every((sample) => sample.byteMatch === steady[0].byteMatch) ? steady[0].byteMatch : "mixed",
      bytes: series(steady.map((sample) => sample.bytes)),
      ttfbMs: series(steady.map((sample) => sample.ttfbMs)),
      totalMs: series(steady.map((sample) => sample.totalMs)),
      samples: steady.map(publishSample),
    },
    errors: 0,
  };
}

function runWrangler(args) {
  const result = spawnSync(wranglerBin, localOnly(args), { cwd: root, encoding: "utf8" });
  if (result.error) die(result.error.message);
  return result;
}

function startDev(port, file) {
  if (listenPids(port).length) die(`port ${port} is already in use. Stop that process before npm run perf:worker.`);
  const args = localOnly(["dev", "--env-file", file, "--port", String(port), "--ip", "127.0.0.1"]);
  const child = spawn(wranglerBin, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  devChild = child;
  devPort = port;
  let text = "";
  const keep = (chunk) => {
    text += chunk.toString();
    if (text.length > 200_000) text = text.slice(-200_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return { child, readLog: () => text };
}

async function waitReady(child, readLog, port) {
  const deadline = Date.now() + READY_MS;
  const readyText = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    const log = scrub(readLog());
    if (child.exitCode !== null) die(`wrangler dev exited ${child.exitCode} before it was ready\n${log.slice(-2000)}`);
    if (log.includes(`Ready on ${readyText}`) && listenPids(port).length) return;
    await sleep(200);
  }
  die(`wrangler dev did not become ready on ${readyText}\n${scrub(readLog().slice(-2000))}`);
}

function pageCounts() {
  const result = runWrangler([
    "d1",
    "execute",
    "bridgekit",
    "--local",
    "--json",
    "--command",
    "SELECT path, views FROM page_views ORDER BY path",
  ]);
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || "d1 execute failed").slice(0, 500) };
  }
  const start = result.stdout.indexOf("[");
  const end = result.stdout.lastIndexOf("]");
  let parsed;
  try {
    if (start === -1 || end < start) throw new Error("no JSON array");
    parsed = JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return { ok: false, error: "d1 execute did not return JSON" };
  }
  const rows = Array.isArray(parsed) ? parsed.flatMap((entry) => entry.results ?? []) : [];
  return {
    ok: true,
    rows: rows.map((row) => ({ path: row.path, views: row.views })),
  };
}

function viewsOf(counts, path) {
  if (!counts?.ok) return 0;
  return counts.rows.reduce((sum, item) => (item.path === path ? sum + Number(item.views) : sum), 0);
}

async function pageCountsSettled(paths, before, needed) {
  let last = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    last = pageCounts();
    if (last.ok && paths.every((path) => viewsOf(last, path) - viewsOf(before, path) >= needed)) return last;
    await sleep(300);
  }
  return last ?? { ok: false, error: "no page count query" };
}

function printTable(routes) {
  const pad = (value, width) => String(value).padStart(width);
  const header = "route".padEnd(44) + pad("status", 8) + "  encoding".padEnd(12) + pad("bytes", 12) + pad("ttfb", 10) + pad("min", 10) + pad("max", 10) + pad("total", 10) + pad("min", 10) + pad("max", 10) + pad("n", 4);
  console.log("");
  console.log(header);
  for (const route of routes) {
    const steady = route.steady;
    const line = (label, status, encoding, bytes, ttfb, total, n) =>
      label.padEnd(44) +
      pad(status, 8) +
      "  " +
      String(encoding).padEnd(10) +
      pad(bytes, 12) +
      pad(ttfb.median ?? ttfb, 10) +
      pad(ttfb.min ?? ttfb, 10) +
      pad(ttfb.max ?? ttfb, 10) +
      pad(total.median ?? total, 10) +
      pad(total.min ?? total, 10) +
      pad(total.max ?? total, 10) +
      pad(n, 4);
    console.log(
      line(
        route.id,
        steady.status,
        steady.contentEncoding,
        steady.bytes.median,
        steady.ttfbMs,
        steady.totalMs,
        steady.ttfbMs.samples.length,
      ),
    );
    console.log(
      line(
        `${route.id} first`,
        route.cold.status,
        route.cold.contentEncoding,
        route.cold.bytes,
        { median: route.cold.ttfbMs, min: route.cold.ttfbMs, max: route.cold.ttfbMs },
        { median: route.cold.totalMs, min: route.cold.totalMs, max: route.cold.totalMs },
        1,
      ),
    );
  }
}

async function main() {
  if (!existsSync(join(root, "server", "worker.ts"))) die("Run this from the repository root");
  if (!existsSync(wranglerBin)) die("wrangler is not installed. Run npm ci.");
  const count = sampleCount();
  const out = resolve(root, option("--out") ?? defaultOut);
  assertFullRun(out, count);
  const atStart = machineInfo();
  const port = devPortFromConfig();
  devPort = port;
  printPgrep("before");
  if (!existsSync(join(root, "dist", "app", "index.html"))) die("dist/app/index.html is missing. Run npm run build:cloudflare first.");

  const migration = runWrangler(["d1", "migrations", "apply", "bridgekit", "--local"]);
  if (migration.status !== 0) die(migration.stderr || migration.stdout || "local migration failed");
  const version = runWrangler(["--version"]);
  if (version.status !== 0) die(version.stderr || "wrangler --version failed");

  const assets = wasmAssets();
  const routes = buildRoutes(assets);
  envFile = writeAuthEnv();
  const started = startDev(port, envFile);
  const timed = [];
  let counts = null;
  let beforeCounts = null;
  let pagePaths = [];
  let countedPaths = [];
  try {
    await waitReady(started.child, started.readLog, port);
    if (/--remote\b/.test(scrub(started.readLog()))) die("wrangler dev reported --remote. Refusing to continue.");
    const origin = `http://127.0.0.1:${port}`;
    beforeCounts = pageCounts();
    if (!beforeCounts.ok) die(`page counts were not readable before the run: ${beforeCounts.error}`);
    for (let i = 0; i < routes.length; i++) {
      console.error(`route ${routes[i].id}`);
      timed.push(await timeRoute(origin, routes[i], count, i === 0));
    }
    pagePaths = [...new Set(timed.filter((route) => route.group === "page").map((route) => route.finalPath))];
    countedPaths = [...new Set(timed.filter((route) => route.pageCounted).map((route) => route.finalPath))];
    const needed = count + WARMUP + 1;
    counts = await pageCountsSettled(countedPaths, beforeCounts, needed);
    const log = scrub(started.readLog());
    if (log.includes("count failed")) die("page count logged a failure. The response timings do not include a successful insert.");
    if (!counts.ok) die(`page counts were not readable: ${counts.error}`);
    const missing = countedPaths.filter((path) => viewsOf(counts, path) - viewsOf(beforeCounts, path) < needed);
    if (missing.length) die(`page counts did not rise by ${needed} for ${missing.join(", ")}. rows ${JSON.stringify(counts.rows)}`);
  } finally {
    await stopDev();
  }

  printPgrep("after");
  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    definitions: {
      ttfbMs: "Time from sending the request until the first response headers arrive. For a page that redirects, this is the redirect, not the HTML.",
      totalMs: "Time from sending the request until the final response body ends. Page redirects are included.",
      bytes: "Bytes received on the wire. The client does not decompress them.",
      contentEncoding: "The content-encoding header on the response, or identity when that header is absent.",
      byteMatch: "stored-br, stored-gz, or raw when the wire size equals that file. other when it equals none of them. null for routes that are not wasm.",
      cold: "The first request to that route in this process. Only page-home is the first request after wrangler dev becomes ready.",
      steady: "Five requests after one discarded warm-up. The median is the middle sample.",
      pageCount: "A 200 HTML response from the Worker schedules countPageView. The script then reads local D1 and requires that rise on routes whose final path is the path it requested. A redirect onto a path outside run_worker_first is stored and not required. There is no public route that reads the counts.",
      authEnv: "wrangler dev receives a generated BETTER_AUTH_SECRET through --env-file. .dev.vars is not read. Commentary, Paddle, and sign-in keys are unset.",
    },
    productionBlindSpots: [
      "The clock is local wrangler dev, which is miniflare on this machine. It is not the Cloudflare edge and it has no edge cache.",
      "Cloudflare replaces the browser Accept-Encoding with br, gzip before the Worker runs. The browser header is request.cf.clientAcceptEncoding. Local wrangler does not do that replacement.",
      "Miniflare can recompress a Worker response. When gzip is listed before br, a body the Worker stored as Brotli can arrive as gzip. cache-control no-transform does not stop that in local dev.",
      "Page-count inserts run in waitUntil after the response. totalMs ends when the body ends.",
    ],
    git: gitInfo(),
    machine: { ...atStart, loadAvgAtEnd: loadavg() },
    wrangler: {
      version: version.stdout.trim(),
      command: "wrangler dev --env-file <generated> --port <wrangler.jsonc dev.port> --ip 127.0.0.1",
      remote: false,
      port,
      ip: "127.0.0.1",
    },
    sampleCount: count,
    warmupDiscarded: WARMUP,
    pageCounts: {
      before: beforeCounts.rows,
      after: counts.rows,
      delta: pagePaths.map((path) => ({
        path,
        views: viewsOf(counts, path) - viewsOf(beforeCounts, path),
        countedByWorker: countedPaths.includes(path),
      })),
    },
    routes: timed,
    vetting: {
      requestErrors: 0,
      unexpectedStatuses: 0,
      routes: timed.length,
      pageCountsRecorded: true,
    },
  };

  mkdirSync(join(root, "perf"), { recursive: true });
  const partial = `${out}.partial`;
  writeFileSync(partial, JSON.stringify(report, null, 2) + "\n");
  rmSync(out, { force: true });
  const renamed = spawnSync("mv", [partial, out], { encoding: "utf8" });
  if (renamed.status !== 0) die(renamed.stderr || "could not move the result into place");
  printTable(timed);
  console.log(`page counts ${JSON.stringify(report.pageCounts.delta)}`);
  console.log(`wrote ${out}`);
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopDev();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
  process.exit(code);
}

process.on("SIGINT", () => { void shutdown(1); });
process.on("SIGTERM", () => { void shutdown(1); });

main()
  .then(() => shutdown(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    return shutdown(1);
  });
