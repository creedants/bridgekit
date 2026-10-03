import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
export async function open(port = 9340) {
  const chrome = spawn("chromium", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, "--window-size=1360,900", `--user-data-dir=/tmp/bridgekit-smoke-profile-${port}`, "about:blank"], { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  const requests = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } else if (d.method === "Network.requestWillBeSent") { requests.push({ url: d.params.request.url, method: d.params.request.method, hasBody: Boolean(d.params.request.hasPostData) }); } };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result?.value; };
  const waitFor = async (expr, tries = 200) => { for (let i = 0; i < tries; i++) { if (await evalJs(expr)) return; await sleep(250); } throw new Error("timeout " + expr + " :: " + (await evalJs("document.body.innerText.slice(0,300)"))); };
  const helpers = `window.T = { btn: (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t), sel: (label) => [...document.querySelectorAll('label')].find(l => l.firstChild?.textContent?.trim().startsWith(label))?.querySelector('select'), set: (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }, tab: (t) => [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith(t)).click(), err: () => document.querySelector('.error')?.textContent ?? null }; true`;
  await send("Network.enable");
  return {
    send, evalJs, waitFor, sleep, requests,
    size: (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
    goto: async (url) => { await send("Page.navigate", { url }); await sleep(600); await waitFor("document.readyState === 'complete'"); await evalJs(helpers); },
    shot: async (name, full = false) => writeFileSync(name, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full })).data, "base64")),
    close: () => { ws.close(); chrome.kill(); },
  };
}
