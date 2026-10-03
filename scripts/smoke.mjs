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

const tabs = ["Movers", "Price changes", "Price gaps", "Trend", "Unmatched", "Setup check", "Data check", "Bridge"];
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

browser.close();
console.log("smoke test passed");
