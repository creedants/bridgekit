import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stops a branded Chrome's own calls home. They come from the browser process, which no session reports.
const QUIET = ["--disable-background-networking", "--disable-component-update", "--no-first-run"];
// Chrome announces its own pages and extensions beside the site's. They are not the site under test.
const OWN = /^chrome(-extension)?:/;

/**
 * A page, frame or worker the site under test started. Appended when Chrome announces it, before its first line runs.
 * @typedef {object} Asker
 * @property {string} kind  CDP target type: "page", "worker", "shared_worker", "service_worker", "iframe".
 * @property {string} url
 */
/**
 * One attempt by an asker to open a connection. Appended when the attempt starts.
 * @typedef {object} NetworkRecord
 * @property {string} from      The asker's kind.
 * @property {string} url
 * @property {string} method    HTTP method, or "WEBSOCKET" for a socket open.
 * @property {boolean} hasBody
 * @property {string | null} blocked  CDP blockedReason when the browser refused the attempt ("csp", ...). null means sent or still in flight.
 */
/**
 * One refusal by the content security policy. Appended when Chrome reports it.
 * @typedef {object} Violation
 * @property {string} from       The asker's kind.
 * @property {string} directive
 * @property {string} url        "" when what was refused is not a request (an inline script, eval).
 */
/**
 * @typedef {object} Options
 * @property {string} [chromium]  Binary to start: a name on PATH or a path. Default "chromium".
 * @property {boolean} [record]
 */
/**
 * @typedef {object} Browser
 * @property {(method: string, params?: object) => Promise<any>} send
 * @property {(expression: string) => Promise<any>} evalJs
 * @property {(expression: string, tries?: number) => Promise<void>} waitFor
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(width: number, height: number) => Promise<any>} size
 * @property {(url: string) => Promise<void>} goto
 * @property {(name: string, full?: boolean) => Promise<void>} shot
 * @property {() => Promise<void>} close
 * @property {Asker[]} askers
 * @property {NetworkRecord[]} network
 * @property {Violation[]} violations
 */

/**
 * `record: true` holds each frame and worker at its first line until it is watched, which the benchmark must not
 * time, so it is opt-in. The binary is the caller's choice and no environment variable is read here: the benchmark
 * probes `chromium --version` and must time that same binary.
 * @param {number} [port]
 * @param {Options} [options]
 * @returns {Promise<Browser>}
 */
export async function open(port = 9340, { chromium = "chromium", record = false } = {}) {
  // A browser already on this port would be reused with whatever it stored, so refuse instead.
  const taken = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
  if (taken) throw new Error(`Port ${port} is already in use, probably by a browser left from an earlier run. Stop it and try again.`);
  // An interrupted run leaves its directory. The port is free, so no live browser still has it open.
  const prefix = `bridgekit-browser-${port}-`;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(prefix)) continue;
    try { rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 3 }); } catch { /* a busy directory must not throw into the benchmark */ }
  }
  // Its own directory per launch. Nothing an earlier run stored reaches this one, and the last browser on this
  // port, still exiting, cannot remove this one's profile.
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  const stderrPath = join(scratch, "stderr");
  // A file and not a pipe, so a browser that outlives this process never blocks on a full pipe.
  const stderrFd = openSync(stderrPath, "w");
  // Its own process group, so close() stops the browser and not just the launcher.
  const chrome = spawn(chromium, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, "--window-size=1360,900", `--user-data-dir=${join(scratch, "profile")}`, ...(record ? QUIET : []), "about:blank"], { stdio: ["ignore", "ignore", stderrFd], detached: true });
  closeSync(stderrFd);
  let failed = null;
  let ready = false;
  // A profile Chrome still has open must not throw into the benchmark.
  const removeScratch = () => { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
  const stderrTail = () => { try { return readFileSync(stderrPath, "utf8").slice(-2000).trim(); } catch { return ""; } };
  const exited = new Promise((resolve) => {
    const finish = () => { removeScratch(); resolve(); };
    chrome.once("error", (error) => {
      if (!ready) failed ??= `Could not start "${chromium}": ${error.message}.`;
      finish();
    });
    chrome.once("exit", (code, signal) => {
      // An exit after open() resolved is the caller stopping the browser, not a startup failure.
      if (!ready) failed ??= `"${chromium}" exited (${signal ?? code}) before its debugging port opened. Its last output:\n${stderrTail()}`;
      finish();
    });
  });
  const stop = () => { try { process.kill(-chrome.pid, "SIGTERM"); } catch {} };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(1); });
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let target;
    for (let i = 0; i < 40 && !target && !failed; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
    if (!target) { stop(); throw new Error(failed ?? `"${chromium}" opened no page on debugging port ${port} within 10 s.`); }
    // With record, the browser's own endpoint: the only one that announces a shared worker. Otherwise the page's.
    const endpoint = record ? (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl : target.webSocketDebuggerUrl;
    const ws = new WebSocket(endpoint);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    /** @type {Asker[]} */ const askers = [];
    /** @type {NetworkRecord[]} */ const network = [];
    /** @type {Violation[]} */ const violations = [];
    const sources = new Map();
    const sessions = new Set();
    const known = new Set();
    const attempts = new Map();
    // The first recorder command Chrome refused. Once set, every command and every read throws it.
    let broken = null;
    const command = (method, params, sessionId) => new Promise((resolve, reject) => {
      if (record && broken) return reject(broken);
      pending.set(++id, (d) => (record && d.error ? reject(new Error(`${method} failed: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const held = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
    let announce;
    const announced = new Promise((resolve) => (announce = resolve));
    const note = (d) => {
      if (d.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo: { targetId, type: kind, url } } = d.params;
        sessions.add(sessionId);
        const tell = (method, params = {}) => command(method, params, sessionId).catch((error) => { broken ??= new Error(`${error.message}, so the ${kind} at ${url} was not recorded`); });
        // A service worker is announced by the browser and again by its page. One session records it, so each attempt has one record.
        if (!OWN.test(url) && !known.has(targetId)) {
          known.add(targetId);
          sources.set(sessionId, kind);
          askers.push({ kind, url });
          // In this order: the target stays held at its first line until its requests are reported.
          tell("Network.enable");
          tell("Audits.enable");
          tell("Target.setAutoAttach", held);
        }
        tell("Runtime.runIfWaitingForDebugger");
        if (targetId === target.id) announce(sessionId);
        return;
      }
      if (!/^(Network|Audits)\./.test(d.method)) return;
      const from = sources.get(d.sessionId);
      if (!from) {
        if (!sessions.has(d.sessionId)) broken ??= new Error(`${d.method} came from a session Chrome never announced, so its asker is unknown`);
        return;
      }
      if (d.method === "Audits.issueAdded") {
        const refused = d.params.issue.details?.contentSecurityPolicyIssueDetails;
        if (refused && !refused.isReportOnly) violations.push({ from, directive: refused.violatedDirective ?? "", url: refused.blockedURL ?? "" });
        return;
      }
      const key = `${d.sessionId ?? ""}:${d.params?.requestId}`;
      const add = (url, method, hasBody) => { const entry = { from, url, method, hasBody, blocked: null }; network.push(entry); attempts.set(key, entry); };
      if (d.method === "Network.requestWillBeSent") add(d.params.request.url, d.params.request.method, Boolean(d.params.request.hasPostData));
      else if (d.method === "Network.webSocketCreated") add(d.params.url, "WEBSOCKET", false);
      else if (d.method === "Network.loadingFailed" && d.params.blockedReason && attempts.has(key)) attempts.get(key).blocked = d.params.blockedReason;
    };
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (record && d.method) note(d); };
    if (record) await command("Target.setAutoAttach", held);
    const page = record ? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`"${chromium}" never announced its page`)), 10000);
      announced.then((sessionId) => { clearTimeout(timer); resolve(sessionId); });
    }) : undefined;
    const send = (method, params = {}) => command(method, params, page);
    const read = (list) => {
      if (!record) throw new Error("This browser keeps no record. open(port, { record: true }) records the page and every frame and worker.");
      if (broken) throw broken;
      return list;
    };
    const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result?.value; };
    const waitFor = async (expr, tries = 200) => { for (let i = 0; i < tries; i++) { if (await evalJs(expr)) return; await sleep(250); } throw new Error("timeout " + expr + " :: " + (await evalJs("document.body.innerText.slice(0,300)"))); };
    const helpers = `window.T = { btn: (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t), sel: (label) => [...document.querySelectorAll('label')].find(l => l.firstChild?.textContent?.trim().startsWith(label))?.querySelector('select'), set: (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }, input: (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, tab: (t) => [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith(t)).click(), err: () => document.querySelector('.error')?.textContent ?? null }; true`;
    // Enabling the Network domain is part of the timed browser launch.
    await send("Network.enable");
    ready = true;
    return {
      send, evalJs, waitFor, sleep,
      /** The page and every frame and worker the site started since open(). Live: it grows as the run goes on. */
      get askers() { return read(askers); },
      /** Every attempt since open(), by every asker, in order. Live: it grows as the run goes on. */
      get network() { return read(network); },
      /**
       * What the content security policy refused, in order. Live. Chromium refuses a fetch() before it becomes a
       * request, so that attempt is in no record and is known only from the policy issue the browser reports.
       */
      get violations() { return read(violations); },
      size: (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
      goto: async (url) => { await send("Page.navigate", { url }); await sleep(600); await waitFor("document.readyState === 'complete'"); await evalJs(helpers); },
      shot: async (name, full = false) => writeFileSync(name, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full })).data, "base64")),
      close: () => { ws.close(); stop(); return exited; },
    };
  } catch (error) {
    if (!ready) stop();
    throw error;
  }
}
