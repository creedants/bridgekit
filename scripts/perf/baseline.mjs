// Rebuilds dist, times the Node bridge and a headless tool page, writes perf/baseline.json.
// Definitions of each metric live in the JSON under `definitions` and in perf/README.md.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, loadavg, arch, platform, release } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { open } from "../cdp.mjs";
import { openDatabase } from "../../src/duckdb.ts";
import { dataCheck, runBridge } from "../../src/engine.ts";
import { createSyntheticSales } from "../../src/synth.ts";

const SIZES = [
  { name: "small", rows: 10_000, browser: true },
  { name: "medium", rows: 300_000, browser: true },
  { name: "large", rows: 3_000_000, browser: false },
];
const WARMUP = 1;
const GZIP_LEVEL = constants.Z_DEFAULT_COMPRESSION;
const BROTLI_QUALITY = 5;
const MONEY_DECIMALS = 2;
const SHARE_DECIMALS = 5;
const WASM_MIN_BYTES = 5_000_000;

const BRIDGE = {
  table: "sales",
  periodColumn: "year",
  prior: 2025,
  current: 2026,
  unitsColumn: "units",
  salesColumn: "sales",
  levels: [
    { name: "Model", columns: ["model"] },
    { name: "Finish", columns: ["finish"] },
    { name: "Color", columns: ["color", "upgrade"] },
    { name: "Material", columns: ["material"] },
  ],
};

const CSV_COLUMNS = ["year", "customer", "model", "finish", "color", "upgrade", "material", "delivery", "units", "sales"];
const DEFAULT_CSV_DIR = "/tmp/bridgekit-perf";

// The mark fires when the empty tool is ready. DuckDB opens after the load event, on an idle callback, unless Save-Data is on. A pick delay waits after this mark.
const INTERACTIVE_WATCH = `
window.__interactiveMs = null;
(function watch() {
  const input = document.querySelector('input[type="file"][accept*="csv"]');
  const heading = document.querySelector("h1");
  if (input && !input.disabled && heading && heading.textContent.trim() === "Load a sales file") {
    window.__interactiveMs = performance.now();
    return;
  }
  setTimeout(watch, 16);
})();
`;

const root = process.cwd();
const defaultOut = resolve(root, "perf", "baseline.json");

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
  const raw = process.env.PERF_SAMPLES ?? "5";
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) die("PERF_SAMPLES must be a positive integer");
  return count;
}

function pickDelayMs() {
  const raw = option("--pick-delay");
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) die("--pick-delay needs a non-negative integer number of milliseconds");
  const delay = Number(raw);
  if (delay > 120_000) die("--pick-delay must be at most 120000 milliseconds");
  return delay;
}

// An explicit size list replaces the default table for that run, and every
// listed size runs in the browser. A plain run without this flag is unchanged.
function parseSizesArg() {
  const raw = option("--sizes");
  if (raw === undefined) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) die("--sizes needs a comma-separated list of row counts");
  return parts.map((part) => {
    if (!/^\d+$/.test(part)) die("--sizes needs a comma-separated list of row counts");
    const rows = Number(part);
    if (!Number.isSafeInteger(rows) || rows < 1) die("--sizes needs a comma-separated list of row counts");
    if (rows > 20_000_000) die("--sizes row counts must be at most 20000000");
    return { name: `rows-${rows}`, rows, browser: true };
  });
}

function resolveSizes() {
  return parseSizesArg() ?? SIZES;
}

// Generated CSVs live in a private run directory under the base directory.
// The base defaults to the historical directory. A --csv-dir override only
// changes that base and never changes the measured numbers. The run creates
// one sub-directory for its own files and removes only that directory.
let activeCsvRunDir = null;

function csvDir() {
  const raw = option("--csv-dir");
  if (raw === undefined) return DEFAULT_CSV_DIR;
  if (raw.length === 0) die("--csv-dir needs a value");
  return raw;
}

function assertFullRun(out, count) {
  const partial = process.argv.includes("--skip-build") || option("--only") || option("--sizes") || count !== 5 || pickDelayMs() !== 0;
  if (partial && resolve(root, out) === defaultOut) {
    die("A partial run cannot write perf/baseline.json. Pass --out to another path.");
  }
}

function series(samples) {
  if (samples.length === 0) die("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { median, min: sorted[0], max: sorted[sorted.length - 1], samples };
}

function roundDigits(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function cents(value) {
  return roundDigits(value, MONEY_DECIMALS);
}

function parseAmount(text) {
  const value = Number(String(text).replace(/[,\s+]/g, "").replace(/[−–]/g, "-"));
  if (!Number.isFinite(value)) die(`could not read an amount from "${text}"`);
  return value;
}

function fingerprint(result) {
  const money = {
    priorSales: cents(result.priorSales),
    currentSales: cents(result.currentSales),
    effects: result.effects.map((effect) => [effect.key, cents(effect.value)]),
  };
  const coverage = result.coverage.map((row) => [
    row.level,
    row.cells,
    cents(row.sales),
    roundDigits(row.share, SHARE_DECIMALS),
  ]);
  const body = { ...money, coverage };
  return {
    sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    priorSales: result.priorSales,
    currentSales: result.currentSales,
    effects: result.effects.map((effect) => ({ key: effect.key, label: effect.label, value: effect.value })),
    coverage: result.coverage.map((row) => ({
      level: row.level,
      label: row.label,
      cells: row.cells,
      sales: row.sales,
      share: row.share,
    })),
    rounded: body,
  };
}

function maxDelta(a, b) {
  let money = Math.abs(a.priorSales - b.priorSales);
  money = Math.max(money, Math.abs(a.currentSales - b.currentSales));
  let share = 0;
  for (let i = 0; i < a.effects.length; i++) money = Math.max(money, Math.abs(a.effects[i].value - b.effects[i].value));
  for (let i = 0; i < a.coverage.length; i++) {
    money = Math.max(money, Math.abs(a.coverage[i].sales - b.coverage[i].sales));
    share = Math.max(share, Math.abs(a.coverage[i].share - b.coverage[i].share));
  }
  return { money, share };
}

function gitInfo() {
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const sha = run(["rev-parse", "HEAD"]);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--porcelain"]);
  if (sha.status !== 0) die(sha.stderr);
  return {
    sha: sha.stdout.trim(),
    branch: branch.stdout.trim(),
    porcelain: status.stdout.trim(),
  };
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

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function kindOf(file) {
  const ext = extname(file);
  if (ext === ".js") return "js";
  if (ext === ".wasm") return "wasm";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  return "other";
}

function measureAssets(dist) {
  const assets = walk(dist)
    .map((file) => {
      const bytes = readFileSync(file);
      const gzipBytes = gzipSync(bytes, { level: GZIP_LEVEL }).length;
      const brotliBytes = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      }).length;
      const path = relative(dist, file).split(sep).join("/");
      console.error(`asset ${path} ${bytes.length} bytes`);
      return { path, kind: kindOf(file), bytes: bytes.length, gzipBytes, brotliBytes };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const totals = { js: 0, wasm: 0, css: 0, html: 0, other: 0, all: 0, gzipBytes: 0, brotliBytes: 0 };
  for (const asset of assets) {
    totals[asset.kind] += asset.bytes;
    totals.all += asset.bytes;
    totals.gzipBytes += asset.gzipBytes;
    totals.brotliBytes += asset.brotliBytes;
  }
  return { assets, totals };
}

function globalHeaders(dist) {
  const file = join(dist, "_headers");
  if (!existsSync(file)) return {};
  const headers = {};
  let inGlobal = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      inGlobal = line.trim() === "/*";
      continue;
    }
    if (!inGlobal) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("!")) continue;
    const split = trimmed.indexOf(":");
    if (split === -1) continue;
    headers[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
  }
  return headers;
}

function startServer(dist, port) {
  const missing = [];
  const hits = [];
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".csv": "text/csv; charset=utf-8",
    ".png": "image/png",
  };
  const extra = globalHeaders(dist);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    let file = join(dist, rel);
    const escaped = relative(dist, file);
    if (escaped.startsWith("..") || escaped.split(sep).includes("..")) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      missing.push(url.pathname);
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = statSync(file);
    const hit = { path: url.pathname, bytes: stat.size, ms: null };
    hits.push(hit);
    const started = performance.now();
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      ...extra,
    });
    if (req.method === "HEAD") {
      hit.ms = Math.round(performance.now() - started);
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("close", () => {
      hit.ms = Math.round(performance.now() - started);
    });
    stream.pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({
      server,
      missing,
      port,
      takeHits() {
        return hits.splice(0, hits.length);
      },
    }));
  });
}

async function timeEngine(count, table, dir) {
  const sizes = [];
  mkdirSync(dir, { recursive: true });
  for (const size of table) {
    console.error(`engine ${size.name} ${size.rows} rows`);
    const query = await openDatabase();
    const generateMs = [];
    const bridgeMs = [];
    const dataCheckMs = [];
    const generateUserMs = [];
    const generateSystemMs = [];
    const bridgeUserMs = [];
    const bridgeSystemMs = [];
    const prints = [];
    let warmup = null;
    let duckdbThreads = null;
    let checkedRows = null;
    const [threadRow] = await query("SELECT current_setting('threads') AS threads");
    duckdbThreads = Number(threadRow.threads);
    for (let i = 0; i < WARMUP + count; i++) {
      const genCpu = process.cpuUsage();
      const genStart = performance.now();
      await createSyntheticSales(query, size.rows);
      const genWall = Math.round(performance.now() - genStart);
      const genCpuMs = process.cpuUsage(genCpu);
      const bridgeCpu = process.cpuUsage();
      const bridgeStart = performance.now();
      const result = await runBridge(query, BRIDGE);
      const bridgeWall = Math.round(performance.now() - bridgeStart);
      const bridgeCpuMs = process.cpuUsage(bridgeCpu);
      const checkStart = performance.now();
      const checked = await dataCheck(query, BRIDGE);
      const checkWall = Math.round(performance.now() - checkStart);
      if (checked.rows !== size.rows) die(`${size.name} data check saw ${checked.rows} rows`);
      const print = fingerprint(result);
      if (result.priorSales <= 0 || result.currentSales <= 0) die(`${size.name} bridge totals are zero`);
      if (i < WARMUP) {
        warmup = { generateMs: genWall, bridgeMs: bridgeWall, dataCheckMs: checkWall };
        console.error(`  warmup generate ${genWall}ms bridge ${bridgeWall}ms data check ${checkWall}ms`);
        continue;
      }
      generateMs.push(genWall);
      bridgeMs.push(bridgeWall);
      dataCheckMs.push(checkWall);
      checkedRows = checked;
      generateUserMs.push(Math.round(genCpuMs.user / 1000));
      generateSystemMs.push(Math.round(genCpuMs.system / 1000));
      bridgeUserMs.push(Math.round(bridgeCpuMs.user / 1000));
      bridgeSystemMs.push(Math.round(bridgeCpuMs.system / 1000));
      prints.push({ print, result });
      console.error(`  sample ${generateMs.length}/${count} generate ${genWall}ms bridge ${bridgeWall}ms data check ${checkWall}ms`);
    }
    let moneyDelta = 0;
    let shareDelta = 0;
    for (let i = 1; i < prints.length; i++) {
      const delta = maxDelta(prints[0].result, prints[i].result);
      moneyDelta = Math.max(moneyDelta, delta.money);
      shareDelta = Math.max(shareDelta, delta.share);
    }
    if (moneyDelta >= 0.01) die(`${size.name} money totals differ by ${moneyDelta}`);
    if (shareDelta >= 0.001) die(`${size.name} coverage shares differ by ${shareDelta}`);
    const hashes = new Set(prints.map((item) => item.print.sha256));
    if (hashes.size !== 1) die(`${size.name} rounded fingerprints differ`);
    let csv = null;
    if (size.browser) {
      csv = join(dir, `${size.rows}.csv`);
      rmSync(csv, { force: true });
      const sqlPath = csv.replaceAll("'", "''");
      await query(
        `COPY (SELECT ${CSV_COLUMNS.join(", ")} FROM sales) TO '${sqlPath}' (HEADER, DELIMITER ',')`,
      );
      const csvBytes = statSync(csv).size;
      if (csvBytes < size.rows) die(`${size.name} csv is only ${csvBytes} bytes`);
      console.error(`  csv ${csv} ${csvBytes} bytes`);
    }
    sizes.push({
      name: size.name,
      rows: size.rows,
      warmup,
      duckdbThreads,
      generateMs: series(generateMs),
      bridgeMs: series(bridgeMs),
      dataCheckMs: series(dataCheckMs),
      dataCheck: checkedRows,
      cpu: {
        generateUserMs: series(generateUserMs),
        generateSystemMs: series(generateSystemMs),
        bridgeUserMs: series(bridgeUserMs),
        bridgeSystemMs: series(bridgeSystemMs),
      },
      rssBytes: process.memoryUsage().rss,
      maxAbsMoneyDelta: moneyDelta,
      maxAbsShareDelta: shareDelta,
      fingerprint: prints[0].print,
      errors: 0,
      csv,
    });
  }
  return sizes;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function portInUse(port) {
  return fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
}

async function waitPortFree(port) {
  for (let i = 0; i < 50; i++) {
    if (!(await portInUse(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  die(`Chromium debug port ${port} stayed in use`);
}

async function waitInteractive(browser) {
  const deadline = Date.now() + 30_000;
  let last = "no document yet";
  while (Date.now() < deadline) {
    try {
      const value = await browser.evalJs( "window.__interactiveMs ?? null");
      if (typeof value === "number") return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await browser.sleep(50);
  }
  die(`tool page did not become interactive: ${last}`);
}

const CONFIGURE = `(async () => {
  const set = (label, value) => {
    const lab = [...document.querySelectorAll("label")].find((node) => node.firstChild?.textContent?.trim().startsWith(label));
    const el = lab?.querySelector("select");
    if (!el) throw new Error("missing select " + label);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  set("Period column", "year");
  set("Units", "units");
  set("Sales", "sales");
  set("Gross sales", "");
  set("Cost", "");
  const add = async (name, count) => {
    const el = document.querySelector('select[aria-label="Add attribute"]');
    if (!el || ![...el.options].some((option) => option.value === name)) {
      throw new Error("missing column " + name);
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, name);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (document.querySelectorAll("ol.levels li").length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    throw new Error("attribute " + name + " did not apply");
  };
  await add("model", 1);
  await add("finish", 2);
  await add("color", 3);
  const item = [...document.querySelectorAll("ol.levels li")].find((li) => li.querySelector('[aria-label="Attribute name"]')?.value === "color");
  const combo = item?.querySelector('select[aria-label="Combine another column into this attribute"]');
  if (!combo) throw new Error("could not combine upgrade");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(combo, "upgrade");
  combo.dispatchEvent(new Event("change", { bubbles: true }));
  const upgradeDeadline = performance.now() + 5000;
  while (performance.now() < upgradeDeadline) {
    const chips = [...document.querySelectorAll("ol.levels li .chip")].map((chip) => chip.childNodes[0].textContent.trim());
    if (chips.includes("upgrade")) break;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await add("material", 4);
  const columns = [...document.querySelectorAll("ol.levels li")].map((li) =>
    [...li.querySelectorAll(".chip")].map((chip) => chip.childNodes[0].textContent.trim()),
  );
  const expected = JSON.stringify([["model"], ["finish"], ["color", "upgrade"], ["material"]]);
  if (JSON.stringify(columns) !== expected) throw new Error("columns " + JSON.stringify(columns));
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Calculate bridge");
    const gross = [...document.querySelectorAll("label")].find((node) => node.firstChild?.textContent?.trim().startsWith("Gross sales"))?.querySelector("select");
    const cost = [...document.querySelectorAll("label")].find((node) => node.firstChild?.textContent?.trim().startsWith("Cost"))?.querySelector("select");
    if (gross?.value || cost?.value) throw new Error("gross or cost was set");
    if (button && !button.disabled) {
      window.__marks.ready = performance.now();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Calculate bridge stayed disabled " + document.body.innerText.slice(0, 300));
})()`;

async function loadFile(browser, csvPath, rows) {
  await browser.evalJs( "window.__marks = { file: performance.now() }; true");
  await browser.send("DOM.enable");
  const { root: doc } = await browser.send("DOM.getDocument");
  const { nodeId } = await browser.send("DOM.querySelector", {
    nodeId: doc.nodeId,
    selector: 'input[type="file"][accept*="csv"]',
  });
  if (!nodeId) die("file input was missing");
  await browser.send("DOM.setFileInputFiles", { nodeId, files: [csvPath] });
  await browser.evalJs(
    `new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = () => {
        const error = document.querySelector(".error");
        if (error?.textContent) { reject(new Error(error.textContent)); return; }
        const aside = document.querySelector("aside");
        const status = document.querySelector(".status")?.textContent ?? "";
        if (aside && status === "") {
          window.__marks.parsed = performance.now();
          resolve(true);
          return;
        }
        if (performance.now() - start > 180000) {
          reject(new Error("file read timed out " + document.body.innerText.slice(0, 300)));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    })`,
  );
  await browser.evalJs( CONFIGURE);
  await browser.evalJs(
    `(() => {
      window.__marks.click = performance.now();
      const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "Calculate bridge");
      button.click();
      return true;
    })()`,
  );
  await browser.evalJs(
    `new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = () => {
        const error = document.querySelector(".error");
        if (error?.textContent) { reject(new Error(error.textContent)); return; }
        if (document.querySelector(".kpis") && document.querySelector(".bridge table")) {
          window.__marks.done = performance.now();
          resolve(true);
          return;
        }
        if (performance.now() - start > 180000) {
          reject(new Error("bridge timed out " + document.body.innerText.slice(0, 300)));
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    })`,
  );
  const detail = JSON.parse(
    await browser.evalJs(
      `JSON.stringify({
        marks: window.__marks,
        interactiveMs: window.__interactiveMs,
        source: document.querySelector(".source")?.textContent ?? "",
        nav: (() => {
          const entry = performance.getEntriesByType("navigation")[0];
          return entry ? {
            type: entry.type,
            dcl: entry.domContentLoadedEventEnd,
            load: entry.loadEventEnd,
            transfer: entry.transferSize,
            encoded: entry.encodedBodySize,
            decoded: entry.decodedBodySize
          } : null;
        })(),
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          start: entry.startTime,
          duration: entry.duration,
          transfer: entry.transferSize,
          encoded: entry.encodedBodySize,
          decoded: entry.decodedBodySize
        })),
        rows: [...document.querySelectorAll(".bridge table")[0].rows].slice(1).map((row) => [row.cells[0].innerText, row.cells[1].innerText])
      })`,
    ),
  );
  const expectedRows = rows.toLocaleString("en-US");
  if (!detail.source.includes(`${expectedRows} rows`)) die(`page source was "${detail.source}", expected ${expectedRows} rows`);
  if (!detail.nav || detail.nav.type !== "navigate") die(`navigation type was ${detail.nav?.type ?? "missing"}`);
  const amounts = detail.rows.map((row) => parseAmount(row[1]));
  const prior = amounts[0];
  const current = amounts[amounts.length - 1];
  const effects = amounts.slice(1, -1);
  const residual = prior + effects.reduce((sum, value) => sum + value, 0) - current;
  if (Math.abs(residual) > effects.length + 1) die(`on-screen bridge is off by ${residual}`);
  if (!(prior > 0) || !(current > 0)) die("on-screen bridge totals are zero");
  return { detail, prior, current, effects, residual };
}

function resourcePath(name) {
  return new URL(name).pathname;
}

async function oneBrowser(chromePort, origin, csvPath, rows, hosted, pickDelay) {
  if (await portInUse(chromePort)) die(`debug port ${chromePort} is already in use`);
  hosted.takeHits();
  const browser = await open(chromePort);
  try {
    await browser.send("Page.enable");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: INTERACTIVE_WATCH });
    await browser.send("Page.navigate", { url: `${origin}/app/` });
    const interactiveMs = await waitInteractive(browser);
    const coldHits = hosted.takeHits();
    // The page's idle DuckDB open runs during this wait. file-to-bridge starts afterwards.
    if (pickDelay > 0) await new Promise((resolve) => setTimeout(resolve, pickDelay));
    const wallStart = performance.now();
    const loaded = await loadFile(browser, csvPath, rows);
    const fileHits = hosted.takeHits();
    const totalMs = Math.round(performance.now() - wallStart);
    const marks = loaded.detail.marks;
    const version = await browser.send("Browser.getVersion");
    return {
      totalMs,
      interactiveMs: Math.round(interactiveMs),
      dclMs: Math.round(loaded.detail.nav.dcl),
      loadMs: Math.round(loaded.detail.nav.load),
      parseMs: Math.round(marks.parsed - marks.file),
      configureMs: Math.round(marks.ready - marks.parsed),
      calculateMs: Math.round(marks.done - marks.click),
      prior: loaded.prior,
      current: loaded.current,
      effects: loaded.effects,
      residual: loaded.residual,
      source: loaded.detail.source,
      resources: loaded.detail.resources.map((entry) => ({ ...entry, path: resourcePath(entry.name) })),
      coldHits,
      fileHits,
      chromium: version?.product ?? "",
    };
  } finally {
    browser.close();
    await waitPortFree(chromePort);
  }
}

function matchEngine(sample, engineSize) {
  const expectedEffects = engineSize.fingerprint.effects
    .filter((effect) => effect.key !== "no_units" || effect.value !== 0)
    .map((effect) => Math.round(effect.value));
  const priorOk = Math.abs(sample.prior - Math.round(engineSize.fingerprint.priorSales)) <= 1;
  const currentOk = Math.abs(sample.current - Math.round(engineSize.fingerprint.currentSales)) <= 1;
  const effectsOk =
    sample.effects.length === expectedEffects.length &&
    sample.effects.every((value, index) => Math.abs(value - expectedEffects[index]) <= 1);
  return priorOk && currentOk && effectsOk;
}

async function timeBrowser(engineSizes, distPort, count, hosted, pickDelay, table, dir) {
  process.setMaxListeners(32);
  const chromePort = await freePort();
  const origin = `http://127.0.0.1:${distPort}`;
  const browserSizes = table.filter((size) => size.browser);
  if (browserSizes.length === 0) die("no browser sizes to measure");
  let chromium = "";
  const discarded = [];
  console.error(`browser warmup ${browserSizes[0].name}`);
  const warmup = await oneBrowser(chromePort, origin, join(dir, `${browserSizes[0].rows}.csv`), browserSizes[0].rows, hosted, pickDelay);
  chromium = warmup.chromium;
  discarded.push({ name: browserSizes[0].name, rows: browserSizes[0].rows, ...warmup, resources: undefined });
  console.error(`  discarded warmup total ${warmup.totalMs}ms interactive ${warmup.interactiveMs}ms`);

  const cold = [];
  const files = [];
  for (const size of browserSizes) {
    const samples = [];
    for (let i = 0; i < count; i++) {
      console.error(`browser ${size.name} sample ${i + 1}/${count}`);
      const sample = await oneBrowser(chromePort, origin, join(dir, `${size.rows}.csv`), size.rows, hosted, pickDelay);
      chromium = sample.chromium || chromium;
      const engineSize = engineSizes.find((item) => item.name === size.name);
      if (!matchEngine(sample, engineSize)) {
        die(
          `${size.name} on-screen bridge ${sample.prior} -> ${sample.current} does not match Node ${Math.round(engineSize.fingerprint.priorSales)} -> ${Math.round(engineSize.fingerprint.currentSales)}`,
        );
      }
      const wasm = [...sample.coldHits, ...sample.fileHits].filter((hit) => hit.path.endsWith(".wasm") && hit.bytes >= WASM_MIN_BYTES);
      if (wasm.length === 0) die(`${size.name} did not download the DuckDB wasm`);
      cold.push(sample);
      samples.push(sample);
      console.error(`  total ${sample.totalMs}ms parse ${sample.parseMs}ms configure ${sample.configureMs}ms calculate ${sample.calculateMs}ms`);
    }
    files.push({
      name: size.name,
      rows: size.rows,
      totalMs: series(samples.map((sample) => sample.totalMs)),
      parseMs: series(samples.map((sample) => sample.parseMs)),
      configureMs: series(samples.map((sample) => sample.configureMs)),
      calculateMs: series(samples.map((sample) => sample.calculateMs)),
      displayedPrior: samples[0].prior,
      displayedCurrent: samples[0].current,
      identicalDisplayed: samples.every((sample) => sample.prior === samples[0].prior && sample.current === samples[0].current),
      errors: 0,
      samples: samples.map((sample) => ({
        totalMs: sample.totalMs,
        parseMs: sample.parseMs,
        configureMs: sample.configureMs,
        calculateMs: sample.calculateMs,
        interactiveMs: sample.interactiveMs,
        dclMs: sample.dclMs,
        loadMs: sample.loadMs,
        prior: sample.prior,
        current: sample.current,
        resources: sample.resources,
        coldHits: sample.coldHits,
        fileHits: sample.fileHits,
      })),
    });
  }
  return { chromium, discardedWarmup: discarded, cold, files };
}

function distRel(urlPath) {
  let rel = urlPath.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  return rel;
}

function bytesFor(assets, paths) {
  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const path of paths) {
    const rel = distRel(path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const asset = assets.find((item) => item.path === rel);
    if (!asset) missing.push(path);
    else matched.push(asset);
  }
  return {
    files: matched.map((asset) => ({
      path: asset.path,
      bytes: asset.bytes,
      gzipBytes: asset.gzipBytes,
      brotliBytes: asset.brotliBytes,
    })),
    missing,
    bytes: matched.reduce((sum, asset) => sum + asset.bytes, 0),
    gzipBytes: matched.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    brotliBytes: matched.reduce((sum, asset) => sum + asset.brotliBytes, 0),
  };
}

function downloadSets(cold) {
  const union = (groups) => [...new Set(groups.flat())].sort();
  const before = cold.map((sample) => sample.coldHits.map((hit) => hit.path));
  const duck = cold.map((sample) =>
    sample.fileHits.filter((hit) => hit.path.includes("duckdb") || hit.path.endsWith(".wasm")).map((hit) => hit.path),
  );
  return { firstLoad: union(before), duckdb: union(duck) };
}

function printSummary(report) {
  const rows = [];
  const add = (metric, block, unit) => {
    if (!block) return;
    rows.push({ metric, median: block.median, min: block.min, max: block.max, samples: block.samples.length, unit });
  };
  for (const size of report.engine?.sizes ?? []) {
    add(`engine ${size.name} generate`, size.generateMs, "ms");
    add(`engine ${size.name} bridge`, size.bridgeMs, "ms");
    add(`engine ${size.name} data check`, size.dataCheckMs, "ms");
    add(`engine ${size.name} bridge cpu user`, size.cpu.bridgeUserMs, "ms");
  }
  if (report.browser?.coldLoad) {
    add("browser cold domContentLoaded", report.browser.coldLoad.dclMs, "ms");
    add("browser cold load", report.browser.coldLoad.loadMs, "ms");
    add("browser cold interactive", report.browser.coldLoad.interactiveMs, "ms");
  }
  for (const file of report.browser?.files ?? []) {
    add(`browser ${file.name} file to bridge`, file.totalMs, "ms");
    add(`browser ${file.name} parse`, file.parseMs, "ms");
    add(`browser ${file.name} configure`, file.configureMs, "ms");
    add(`browser ${file.name} calculate`, file.calculateMs, "ms");
  }
  const pad = (value, width) => String(value).padStart(width);
  console.log("");
  console.log(`pick delay ${report.pickDelayMs ?? 0} ms, outside file-to-bridge`);
  console.log("metric".padEnd(42) + pad("median", 12) + pad("min", 12) + pad("max", 12) + pad("n", 6) + "  unit");
  for (const row of rows) {
    console.log(
      row.metric.padEnd(42) +
        pad(row.median, 12) +
        pad(row.min, 12) +
        pad(row.max, 12) +
        pad(row.samples, 6) +
        "  " +
        row.unit,
    );
  }
  if (report.build) {
    console.log("");
    console.log(`dist all ${report.build.totals.all} bytes, js ${report.build.totals.js}, wasm ${report.build.totals.wasm}, css ${report.build.totals.css}`);
    if (report.build.toolPage) console.log(`tool page first load ${report.build.toolPage.bytes} bytes, gzip ${report.build.toolPage.gzipBytes}, brotli ${report.build.toolPage.brotliBytes}`);
    if (report.build.duckdbOnFirstFile) console.log(`duckdb on first file ${report.build.duckdbOnFirstFile.bytes} bytes, gzip ${report.build.duckdbOnFirstFile.gzipBytes}`);
  }
  for (const size of report.engine?.sizes ?? []) {
    const wall = size.bridgeMs.median || 1;
    const cpu = size.cpu.bridgeUserMs.median;
    console.log(`engine ${size.name} bridge cpu/wall ${ (cpu / wall).toFixed(2) } sha256 ${size.fingerprint.sha256.slice(0, 12)} prior ${size.fingerprint.rounded.priorSales} current ${size.fingerprint.rounded.currentSales}`);
  }
}

async function main() {
  if (!existsSync(join(root, "src", "engine.ts"))) die("Run this from the repository root");
  const atStart = machineInfo();
  const count = sampleCount();
  const pickDelay = pickDelayMs();
  const only = option("--only");
  const out = resolve(root, option("--out") ?? defaultOut);
  assertFullRun(out, count);
  if (only && !["assets", "engine", "browser"].includes(only)) die("--only must be assets, engine, or browser");
  const table = resolveSizes();
  const csvBase = csvDir();
  const wantAssets = !only || only === "assets" || only === "engine" || only === "browser";
  const wantEngine = !only || only === "engine" || only === "browser";
  const wantBrowser = !only || only === "browser";
  let dir = csvBase;
  if (wantEngine) {
    mkdirSync(csvBase, { recursive: true });
    dir = mkdtempSync(join(csvBase, "run-"));
    activeCsvRunDir = dir;
  }
  try {
  const chrome = spawnSync("chromium", ["--version"], { encoding: "utf8" });
  if (chrome.status !== 0) die("chromium is not on PATH");

  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild && only !== "browser") await runCommand("npm", ["run", "build"]);
  const dist = join(root, "dist");
  if (!existsSync(join(dist, "app", "index.html"))) die("dist/app/index.html is missing. Run npm run build.");

  const build = wantAssets ? { command: "npm run build", ...measureAssets(dist) } : null;
  if (build && build.totals.wasm < WASM_MIN_BYTES) die(`dist wasm is ${build.totals.wasm} bytes`);

  const engineSizes = wantEngine ? await timeEngine(count, table, dir) : null;
  let browser = null;
  let hosted = null;
  if (wantBrowser) {
    if (!engineSizes) die("browser measurement needs the engine phase");
    const distPort = await freePort();
    hosted = await startServer(dist, distPort);
    try {
      const timed = await timeBrowser(engineSizes, distPort, count, hosted, pickDelay, table, dir);
      const sets = downloadSets(timed.cold);
      const toolPage = bytesFor(build.assets, sets.firstLoad);
      const duckdbOnFirstFile = bytesFor(build.assets, sets.duckdb);
      if (toolPage.missing.length) die(`first load requested unknown files ${toolPage.missing.join(", ")}`);
      if (duckdbOnFirstFile.missing.length) die(`duckdb request missing ${duckdbOnFirstFile.missing.join(", ")}`);
      build.toolPageIncludesWasm = toolPage.files.some((file) => file.path.endsWith(".wasm"));
      build.toolPage = toolPage;
      build.duckdbOnFirstFile = duckdbOnFirstFile;
      const wasmDuringCold = timed.cold.some((sample) => sample.coldHits.some((hit) => hit.path.endsWith(".wasm")));
      browser = {
        harness: "scripts/cdp.mjs",
        chromium: timed.chromium,
        chromiumVersionCommand: chrome.stdout.trim(),
        origin: `http://127.0.0.1:${distPort}/app/`,
        cacheControl: "no-store",
        contentEncoding: "identity",
        pickDelayMs: pickDelay,
        freshProfile: true,
        discardedWarmup: timed.discardedWarmup,
        wasmRequestedBeforeInteractive: wasmDuringCold,
        coldLoad: {
          dclMs: series(timed.cold.map((sample) => sample.dclMs)),
          loadMs: series(timed.cold.map((sample) => sample.loadMs)),
          interactiveMs: series(timed.cold.map((sample) => sample.interactiveMs)),
          samples: timed.cold.length,
        },
        files: timed.files,
      };
    } finally {
      await new Promise((resolve) => hosted.server.close(resolve));
    }
    if (hosted.missing.length) die(`static server 404: ${[...new Set(hosted.missing)].join(", ")}`);
  }

  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    definitions: {
      interactiveMs: "Time until the tool page shows the heading Load a sales file and an enabled file input that accepts csv. The page opens DuckDB after the load event, on an idle callback, unless Save-Data is on. This mark does not wait for that open.",
      fileToBridgeMs: "Wall time from just before the file input is set until the bridge table and the KPI row are on screen. Includes any DuckDB startup still unfinished, the CSV read, attribute setup, and the calculation.",
      parseMs: "From the file mark until the setup panel is on screen and the status text is empty. Includes any DuckDB startup still unfinished and the CSV read.",
      pickDelayMs: "Milliseconds the harness waits after the interactive mark before it sets the file. The wait is outside file-to-bridge. Zero matches the historical run. A non-zero value is a partial run.",
      configureMs: "From parse until Calculate bridge is enabled. The script sets year, units, sales, and the four attributes used by the Node bridge.",
      calculateMs: "From the Calculate bridge click until the bridge table is on screen.",
      generateMs: "createSyntheticSales on one DuckDB connection, after one discarded warm-up. This is the in-app sample-data path, not a user CSV.",
      bridgeMs: "runBridge for Model, Finish, Color (color and upgrade), and Material. Sales, not margin. No gross column.",
      dataCheckMs: "dataCheck after runBridge. The tool awaits this scan before it draws the bridge. It is not included in bridgeMs.",
      identity: `Money rounded to ${MONEY_DECIMALS} decimals and coverage shares rounded to ${SHARE_DECIMALS} decimals. Raw float sums are not bit-stable.`,
      gzipBytes: "zlib gzip at the default level.",
      brotliBytes: `zlib brotli quality ${BROTLI_QUALITY}.`,
      toolPage: "Dist files the local server saw by the time the harness observed the interactive mark. The page sets the mark and the harness polls for it, so a request in that gap is included.",
      duckdbOnFirstFile: "DuckDB wasm and worker files requested after the interactive mark. The window includes a nonzero pick delay and the first file. An idle open that finishes before the mark is counted in toolPage instead.",
      cloudflareBuild: "npm run build:cloudflare is a different bundle. It sets VITE_PAGE_COUNTS, VITE_WORKSPACES, and VITE_AI_COMMENTARY, then stores a Brotli copy and a gzip copy of each wasm file and deletes the original. This script does not run it.",
    },
    git: gitInfo(),
    machine: { ...atStart, chromium: browser?.chromium ?? chrome.stdout.trim(), loadAvgAtEnd: loadavg() },
    sampleCount: count,
    warmupDiscarded: WARMUP,
    pickDelayMs: pickDelay,
    build,
    engine: engineSizes
      ? {
          config: BRIDGE,
          identity: { moneyDecimals: MONEY_DECIMALS, shareDecimals: SHARE_DECIMALS },
          sizes: engineSizes.map(({ csv, ...size }) => size),
        }
      : null,
    browser,
    vetting: {
      errors: 0,
      bridgeTotalsNonZero: true,
      roundedFingerprintsStable: true,
      browserMatchedEngine: Boolean(browser),
      wasmDownloadedOnFirstFile: Boolean(browser),
    },
  };

  mkdirSync(join(root, "perf"), { recursive: true });
  const partial = `${out}.partial`;
  writeFileSync(partial, JSON.stringify(report, null, 2) + "\n");
  rmSync(out, { force: true });
  const renamed = spawnSync("mv", [partial, out], { encoding: "utf8" });
  if (renamed.status !== 0) die(renamed.stderr || "could not move the result into place");
  printSummary(report);
  console.log(`wrote ${out}`);
  } finally {
    if (activeCsvRunDir) {
      rmSync(activeCsvRunDir, { recursive: true, force: true });
      activeCsvRunDir = null;
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => {
    if (activeCsvRunDir) rmSync(activeCsvRunDir, { recursive: true, force: true });
  });
