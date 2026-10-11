import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// Stops a branded Chrome's own calls home. They come from the browser process, which no page session reports.
const QUIET = ["--disable-background-networking", "--disable-component-update", "--no-first-run"];
/**
 * One attempt by the page or a worker to open a connection. Appended when the attempt starts.
 * @typedef {object} NetworkRecord
 * @property {string} from      CDP target type of the asker: "page", "worker", "shared_worker", "service_worker", "iframe"; "unknown" if the session was never announced.
 * @property {string} url
 * @property {string} method    HTTP method, or "WEBSOCKET" for a socket open, so a method allowlist rejects it with no second branch.
 * @property {boolean} hasBody
 * @property {string | null} blocked  CDP blockedReason when the browser refused the attempt ("csp", ...). null means sent or still in flight.
 */
/** `record: true` holds each worker at its first line until it is watched, which the benchmark must not time, so it is opt-in. */
export async function open(port = 9340, { record = false } = {}) {
  // A browser already on this port would be reused with whatever it stored, so refuse instead.
  const taken = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (taken) throw new Error(`Port ${port} is already in use, probably by a browser left from an earlier run. Stop it and try again.`);
  // A fresh profile each run, so nothing a previous run stored affects this one.
  const profile = `/tmp/bridgekit-smoke-profile-${port}`;
  rmSync(profile, { recursive: true, force: true });
  const bin = process.env.CHROMIUM || "chromium";
  // A file and not a pipe, so a browser that outlives this process never blocks on a full pipe.
  const stderrPath = `${profile}.stderr`;
  const stderr = openSync(stderrPath, "w");
  // Its own process group, so close() stops the browser and not just the launcher.
  const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, "--window-size=1360,900", `--user-data-dir=${profile}`, ...(record ? QUIET : []), "about:blank"], { stdio: ["ignore", "ignore", stderr], detached: true });
  closeSync(stderr);
  let failed = null;
  chrome.once("error", (e) => { failed ??= `Could not start "${bin}": ${e.message}. Set CHROMIUM to a Chromium or Chrome binary.`; });
  chrome.once("exit", (code, signal) => { failed ??= `"${bin}" exited (${signal ?? code}) before its debugging port opened. Set CHROMIUM to a Chromium or Chrome binary. Its last output:\n${readFileSync(stderrPath, "utf8").slice(-2000).trim()}`; });
  // Stop it even when a script throws before calling close().
  const stop = () => { try { process.kill(-chrome.pid, "SIGTERM"); } catch {} };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(1); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target;
  for (let i = 0; i < 40 && !target && !failed; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
  if (!target) { stop(); throw new Error(failed ?? `"${bin}" opened no page on debugging port ${port} within 10 s.`); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  /** @type {NetworkRecord[]} */
  const network = [];
  const sources = new Map(), attempts = new Map(), refusals = [];
  let unwatched = null;
  const ask = (method, params, sessionId, done) => { pending.set(++id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); };
  // A target that could not be watched fails the next read instead of running unseen.
  const watch = (method, params, sessionId) => new Promise((r) => ask(method, params, sessionId, (d) => { if (d.error) unwatched ??= new Error(`${method} failed for a ${sources.get(sessionId) ?? "page"}, so its requests were not recorded: ${d.error.message}`); r(); }));
  const held = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  const note = (d) => {
    if (d.method === "Target.attachedToTarget") {
      const session = d.params.sessionId;
      sources.set(session, d.params.targetInfo.type);
      // In this order: the target stays held at its first line until its requests are reported.
      watch("Network.enable", {}, session); watch("Audits.enable", {}, session); watch("Target.setAutoAttach", held, session); watch("Runtime.runIfWaitingForDebugger", {}, session);
      return;
    }
    const from = d.sessionId ? sources.get(d.sessionId) ?? "unknown" : "page";
    if (d.method === "Audits.issueAdded") {
      const refused = d.params.issue.details?.contentSecurityPolicyIssueDetails;
      if (refused?.blockedURL && !refused.isReportOnly) refusals.push({ from, url: refused.blockedURL });
      return;
    }
    const key = `${d.sessionId ?? ""}:${d.params?.requestId}`;
    const add = (url, method, hasBody) => { const entry = { from, url, method, hasBody, blocked: null }; network.push(entry); attempts.set(key, entry); };
    if (d.method === "Network.requestWillBeSent") add(d.params.request.url, d.params.request.method, Boolean(d.params.request.hasPostData));
    else if (d.method === "Network.webSocketCreated") add(d.params.url, "WEBSOCKET", false);
    else if (d.method === "Network.loadingFailed" && d.params.blockedReason && attempts.has(key)) attempts.get(key).blocked = d.params.blockedReason;
  };
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (record && d.method) note(d); };
  const send = (method, params = {}) => new Promise((r) => ask(method, params, undefined, (d) => r(d.result)));
  const read = (value) => { if (!record) throw new Error("This browser keeps no record. open(port, { record: true }) records the page and every worker."); if (unwatched) throw unwatched; return value(); };
  const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result?.value; };
  const waitFor = async (expr, tries = 200) => { for (let i = 0; i < tries; i++) { if (await evalJs(expr)) return; await sleep(250); } throw new Error("timeout " + expr + " :: " + (await evalJs("document.body.innerText.slice(0,300)"))); };
  const helpers = `window.T = { btn: (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t), sel: (label) => [...document.querySelectorAll('label')].find(l => l.firstChild?.textContent?.trim().startsWith(label))?.querySelector('select'), set: (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }, input: (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, tab: (t) => [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith(t)).click(), err: () => document.querySelector('.error')?.textContent ?? null }; true`;
  await send("Network.enable");
  if (record) { await watch("Audits.enable", {}); await watch("Target.setAutoAttach", held); }
  return {
    send, evalJs, waitFor, sleep,
    /** Every attempt since open(), by the page and every worker, in order. Live: it grows as the run goes on. */
    get network() { return read(() => network); },
    /**
     * What the content security policy refused, once per asker and URL. Chromium refuses a fetch() before it becomes a
     * request, so that attempt is in no record and is known only from the policy issue the browser reports.
     */
    get violations() { return read(() => [...network.filter((r) => r.blocked === "csp"), ...refusals].filter((v, i, all) => all.findIndex((w) => w.from === v.from && w.url === v.url) === i).map(({ from, url }) => ({ from, url }))); },
    size: (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
    goto: async (url) => { await send("Page.navigate", { url }); await sleep(600); await waitFor("document.readyState === 'complete'"); await evalJs(helpers); },
    shot: async (name, full = false) => writeFileSync(name, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full })).data, "base64")),
    close: () => { ws.close(); try { process.kill(-chrome.pid, "SIGTERM"); } catch {} },
  };
}
