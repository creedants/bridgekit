// Drives the tool in headless Chromium against a running dev server and fails
// on any error banner or a bridge that does not add up.
//   npm run dev   (in another terminal)
//   npm run smoke [-- http://localhost:5173] [rows]
import { open } from "./cdp.mjs";

const base = process.argv[2] ?? "http://localhost:5173";
const rows = process.argv[3] ?? "";
const browser = await open(9360);
const fail = (message) => {
  console.error("FAIL: " + message);
  browser.close();
  process.exit(1);
};

await browser.size(1360, 1000);
const started = Date.now();
await browser.goto(`${base}/app/?sample${rows ? "=" + rows : ""}`);
await browser.waitFor("!!document.querySelector('.kpis')", 600);
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

// Private by default: load a real file, then prove no data was stored or sent.
await browser.goto(`${base}/app/`);
await browser.evalJs("window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI)); true");
await browser.send("DOM.enable");
const { root } = await browser.send("DOM.getDocument");
const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][accept*=csv]" });
const before = browser.requests.length;
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

const origin = new URL(base).origin;
const sent = browser.requests.slice(before);
const leaks = browser.requests.filter(
  (r) => r.hasBody || !["GET", "HEAD"].includes(r.method) || !(r.url.startsWith(origin) || /^(blob|data):/.test(r.url)),
);
if (leaks.length) fail(`requests that could carry data: ${JSON.stringify(leaks.slice(0, 5))}`);
console.log(`ok  network: ${browser.requests.length} requests, all GET to ${origin}; ${sent.length} after the file was loaded`);

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
      violations: window.__violations,
    });
  })()`),
);
const kept = Object.entries(stored).filter(
  ([key, value]) => !["violations", "localStorage"].includes(key) && (Array.isArray(value) ? value.length : value),
);
if (kept.length) fail(`data left in the browser: ${JSON.stringify(Object.fromEntries(kept))}`);
if (stored.violations.length) fail(`content policy violations: ${stored.violations.join("; ")}`);
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
  await browser.goto(`${base}/app/`);
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

browser.close();
console.log("smoke test passed");
