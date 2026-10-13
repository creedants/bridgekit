import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stops a branded Chrome's own calls home. They come from the browser process, which no session reports.
const QUIET = ["--disable-background-networking", "--disable-component-update", "--no-first-run"];
// Chrome announces its own pages and extensions beside the site's. They are not the site under test.
const OWN = /^chrome(-extension)?:/;
/** `from` of a request the browser's gate saw and no recorded asker announced. */
const UNWATCHED = "unwatched";
/** Longer than any reply smoke waits for. The Excel export polls for up to 80 s inside one evaluation. */
const REPLY_MS = 120_000;
/** How long a listed target may take to leave before that is a fault. */
const SETTLE_MS = 5_000;
/** A detach arrives before the target is destroyed. */
const GRACE_MS = 200;

/**
 * A page, frame or worker the site under test started. Appended when Chrome announces it, before its first line runs.
 * @typedef {object} Asker
 * @property {string} kind  CDP target type: "page", "worker", "shared_worker", "service_worker", "iframe".
 * @property {string} url
 */
/**
 * One attempt to open a connection. Appended when the attempt is first reported, before Chrome sends it.
 * @typedef {object} NetworkRecord
 * @property {string} from      The asker's kind, or "unwatched" when the gate saw it and no recorded asker announced it.
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
 * Everything one browser's pages and workers did, from open() until the browser exited.
 * @typedef {object} Recording
 * @property {readonly Asker[]} askers
 * @property {readonly NetworkRecord[]} network
 * @property {readonly Violation[]} violations
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
 * @property {() => Promise<Recording>} finish  With record only. The browser has exited when this resolves.
 * @property {() => Promise<void>} close
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
  let browserExit = null;
  const exited = new Promise((resolve) => {
    const done = () => { removeScratch(); resolve(); };
    chrome.once("error", (error) => {
      if (!ready) failed ??= `Could not start "${chromium}": ${error.message}.`;
      done();
    });
    chrome.once("exit", (code, signal) => {
      // An exit after open() resolved is the caller stopping the browser, not a startup failure.
      browserExit = { code, signal, stderr: stderrTail() };
      if (!ready) failed ??= `"${chromium}" exited (${signal ?? code}) before its debugging port opened. Its last output:\n${browserExit.stderr}`;
      done();
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
    /** File chooser openings seen while interception is on. */
    const fileChoosers = [];
    /**
     * sessionId → the asker that session reports for, or null when the session is no recorder.
     * Never pruned, so an event in flight when its session detached still names its asker.
     * @type {Map<string, Asker | null>}
     */
    const reporters = new Map();
    /** targetId → the one session recording it. No entry means nothing is recording that target. @type {Map<string, string>} */
    const watched = new Map();
    /** targetId this recorder attached only to ask whether that target still runs. */
    const probing = new Set();
    /** targetId Chrome still lists after its event loop has stopped. */
    const stopped = new Set();
    /** targetId → when it was first listed with no recorder. @type {Map<string, number>} */
    const unwatchedSince = new Map();
    /** requestId → the records of that request's hops, and how many hops each side has reported. @type {Map<string, { records: NetworkRecord[], announced: number, gated: number }>} */
    const hops = new Map();
    // The first recorder fault. Once set, every command and finish() throw it.
    let broken = null;
    let closing = false;
    const closedSocket = (method) => {
      if (closing) return new Error("the browser closed its debugging socket");
      const status = browserExit ? browserExit.signal ?? browserExit.code : "not exited";
      const stderr = browserExit ? browserExit.stderr : stderrTail();
      return new Error(`the browser closed its debugging socket during ${method} (exit ${status}). Its last output:\n${stderr}`);
    };
    const command = (method, params, sessionId) => new Promise((resolve, reject) => {
      if (record && broken) return reject(broken);
      if (record && ws.readyState !== WebSocket.OPEN) return reject(broken ??= closedSocket(method));
      const current = ++id;
      let timer;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        pending.delete(current);
        if (error) reject(error);
        else resolve(result);
      };
      if (record) {
        timer = setTimeout(() => {
          const asker = sessionId ? reporters.get(sessionId) : null;
          const where = asker ? `the ${asker.kind} at ${asker.url}` : sessionId ? "a session with no asker" : "the browser";
          finish(broken ??= new Error(`${method} got no reply in ${REPLY_MS / 1000} s from ${where}, so it crashed or hung and was not recorded`));
        }, REPLY_MS);
      }
      pending.set(current, {
        method,
        reply: (d) => finish(record && d.error ? new Error(`${method} failed: ${d.error.message}`) : null, d.result),
        fail: (error) => finish(error),
      });
      ws.send(JSON.stringify({ id: current, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const held = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
    let announce;
    const announced = new Promise((resolve) => (announce = resolve));
    // Chrome sends one detach for a worker that finished and for a session lost while its target runs.
    const detach = ({ sessionId }) => {
      for (const [targetId, session] of watched) if (session === sessionId) watched.delete(targetId);
    };
    const attach = ({ sessionId, targetInfo: { targetId, type: kind, url } }) => {
      const tell = (method, params = {}) => command(method, params, sessionId).catch((error) => { broken ??= new Error(`${error.message}, so the ${kind} at ${url} was not recorded`); });
      if (probing.has(targetId) || stopped.has(targetId)) reporters.set(sessionId, null);
      else if (OWN.test(url) || watched.has(targetId)) {
        reporters.set(sessionId, null);
        tell("Runtime.runIfWaitingForDebugger");
      } else {
        const asker = { kind, url };
        askers.push(asker);
        reporters.set(sessionId, asker);
        watched.set(targetId, sessionId);
        tell("Network.enable");
        tell("Audits.enable");
        tell("Target.setAutoAttach", held);
        tell("Runtime.runIfWaitingForDebugger");
      }
      if (targetId === target.id) announce(sessionId);
    };
    const hop = (requestId, side, make) => {
      let hopRecord = hops.get(requestId);
      if (!hopRecord) hops.set(requestId, hopRecord = { records: [], announced: 0, gated: 0 });
      const index = hopRecord[side]++;
      if (!hopRecord.records[index]) network.push(hopRecord.records[index] = make());
      return hopRecord.records[index];
    };
    // A request that is never continued is never sent, including the document and Chrome's own requests.
    const gate = ({ requestId, networkId, request }, sessionId) => {
      try {
        const make = () => ({ from: UNWATCHED, url: request.url, method: request.method, hasBody: Boolean(request.hasPostData), blocked: null });
        if (networkId) hop(networkId, "gated", make);
        else network.push(make());
      } finally {
        command("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
      }
    };
    const report = (d) => {
      const asker = reporters.get(d.sessionId);
      if (asker === undefined) {
        broken ??= new Error(`${d.method} came from a session Chrome never announced, so its asker is unknown`);
        return;
      }
      if (d.method === "Page.fileChooserOpened") {
        fileChoosers.push({ backendNodeId: d.params.backendNodeId, mode: d.params.mode });
        return;
      }
      if (!asker) return;
      if (d.method === "Audits.issueAdded") {
        const refused = d.params.issue.details?.contentSecurityPolicyIssueDetails;
        if (refused && !refused.isReportOnly) violations.push({ from: asker.kind, directive: refused.violatedDirective ?? "", url: refused.blockedURL ?? "" });
        return;
      }
      if (d.method === "Network.requestWillBeSent") {
        const { requestId, request } = d.params;
        hop(requestId, "announced", () => ({ from: asker.kind, url: request.url, method: request.method, hasBody: Boolean(request.hasPostData), blocked: null })).from = asker.kind;
        return;
      }
      if (d.method === "Network.webSocketCreated") {
        network.push({ from: asker.kind, url: d.params.url, method: "WEBSOCKET", hasBody: false, blocked: null });
        return;
      }
      if (d.method === "Network.loadingFailed" && d.params.blockedReason) {
        const entry = hops.get(d.params.requestId)?.records.at(-1);
        if (entry) entry.blocked = d.params.blockedReason;
      }
    };
    // Target.getTargets includes the browser itself. It has no page to record.
    const siteTargets = async () => (await command("Target.getTargets")).targetInfos.filter((t) => t.type !== "browser" && !OWN.test(t.url)).map(({ targetId, type, url }) => ({ targetId, type, url }));
    const unrecorded = (target) => `the ${target.type} at ${target.url} is still running and nothing is recording it`;
    // Chrome 155 keeps a dedicated worker listed after its document is gone. The worker still evaluates, and it does not run a timer.
    const executing = async (target) => {
      probing.add(target.targetId);
      let sessionId;
      try {
        sessionId = (await command("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
        await command("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        await command("Runtime.evaluate", { expression: "self.__d16 = 0; setTimeout(() => { self.__d16 = 1; }, 0)", returnByValue: true }, sessionId);
        await sleep(150);
        const probe = await command("Runtime.evaluate", { expression: "self.__d16", returnByValue: true }, sessionId);
        return probe.result?.value === 1;
      } catch (error) {
        if (broken) throw error;
        if (/No target with given id|Target closed/.test(error.message)) return false;
        throw (broken ??= new Error(`${error.message}, so the ${target.type} at ${target.url} was not recorded`));
      } finally {
        if (sessionId) await command("Target.detachFromTarget", { sessionId }).catch(() => {});
        probing.delete(target.targetId);
      }
    };
    const until = async (problem) => {
      const deadline = Date.now() + SETTLE_MS;
      for (;;) {
        const live = await siteTargets();
        const message = await problem(live);
        if (!message) return;
        if (Date.now() >= deadline) throw (broken ??= new Error(message));
        await sleep(50);
      }
    };
    const stray = async (live) => {
      for (const target of live) {
        if (watched.has(target.targetId) || stopped.has(target.targetId)) continue;
        const seen = unwatchedSince.get(target.targetId) ?? Date.now();
        unwatchedSince.set(target.targetId, seen);
        if (Date.now() - seen < GRACE_MS) return unrecorded(target);
        if (await executing(target)) throw (broken ??= new Error(unrecorded(target)));
        stopped.add(target.targetId);
      }
      return null;
    };
    const settle = async () => {
      for (;;) {
        await until(stray);
        if (broken) throw broken;
        const missed = [];
        await Promise.all([...watched].map(async ([targetId, sessionId]) => {
          try { await command("Runtime.evaluate", { expression: "0" }, sessionId); }
          catch (error) { missed.push({ targetId, error }); }
        }));
        if (broken) throw broken;
        if (!missed.length) return;
        const live = await siteTargets();
        const listed = new Set(live.map((t) => t.targetId));
        const present = missed.find((miss) => listed.has(miss.targetId));
        if (present) {
          const target = live.find((t) => t.targetId === present.targetId);
          throw (broken ??= new Error(`${present.error.message}, so the ${target.type} at ${target.url} was not recorded`));
        }
        for (const miss of missed) watched.delete(miss.targetId);
      }
    };
    let markClosed;
    const socketClosed = new Promise((resolve) => (markClosed = resolve));
    // Inspector.targetCrashed is ignored: a shared worker that ends normally emits it.
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      const waiter = d.id && pending.get(d.id);
      if (waiter) { waiter.reply(d); return; }
      if (!record || !d.method) return;
      if (d.method === "Target.attachedToTarget") attach(d.params);
      else if (d.method === "Target.detachedFromTarget") detach(d.params);
      else if (d.method === "Fetch.requestPaused") gate(d.params, d.sessionId);
      else if (/^(Network|Audits)\./.test(d.method) || d.method === "Page.fileChooserOpened") report(d);
    };
    ws.onclose = () => {
      let method = "none";
      for (const entry of pending.values()) method = entry.method;
      let settled = false;
      const rejectWaiters = () => {
        if (settled) return;
        settled = true;
        if (record) {
          const error = closedSocket(method);
          for (const waiter of [...pending.values()]) waiter.fail(error);
        }
        markClosed();
      };
      if (record && !closing && !browserExit) {
        const timer = setTimeout(rejectWaiters, 500);
        chrome.once("exit", () => {
          clearTimeout(timer);
          rejectWaiters();
        });
        return;
      }
      rejectWaiters();
    };
    // Before any target runs, so a request cannot leave until the gate has recorded it.
    if (record) {
      await command("Fetch.enable");
      await command("Target.setAutoAttach", held);
    }
    const page = record ? await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`"${chromium}" never announced its page`)), 10000);
      announced.then((sessionId) => { clearTimeout(timer); resolve(sessionId); });
    }) : undefined;
    const send = (method, params = {}) => command(method, params, page);
    const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); return r.result?.value; };
    const waitFor = async (expr, tries = 200) => { for (let i = 0; i < tries; i++) { if (await evalJs(expr)) return; await sleep(250); } throw new Error("timeout " + expr + " :: " + (await evalJs("document.body.innerText.slice(0,300)"))); };
    const helpers = `window.T = { btn: (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t), sel: (label) => [...document.querySelectorAll('label')].find(l => l.firstChild?.textContent?.trim().startsWith(label))?.querySelector('select'), set: (el, v) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }, input: (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, tab: (t) => [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith(t)).click(), err: () => document.querySelector('.error')?.textContent ?? null }; true`;
    // Enabling the Network domain is part of the timed browser launch.
    await send("Network.enable");
    const goto = async (url) => {
      if (record) await settle();
      await send("Page.navigate", { url });
      await sleep(600);
      await waitFor("document.readyState === 'complete'");
      await evalJs(helpers);
    };
    const finish = async () => {
      if (!record) throw new Error("This browser keeps no record. open(port, { record: true }) records the page and every frame and worker.");
      if (broken) throw broken;
      await goto("about:blank");
      // A shared worker stays listed after its document is gone.
      await until(async (live) => {
        const lost = await stray(live);
        if (lost) return lost;
        const left = live.find((t) => watched.has(t.targetId) && t.type !== "page" && t.type !== "shared_worker");
        return left ? `the ${left.type} at ${left.url} was still running after its document was left` : null;
      });
      await settle();
      closing = true;
      await command("Browser.close");
      await socketClosed;
      stop();
      await exited;
      if (broken) throw broken;
      return Object.freeze({ askers: Object.freeze(askers), network: Object.freeze(network), violations: Object.freeze(violations) });
    };
    ready = true;
    return {
      send, evalJs, waitFor, sleep, goto, finish,
      size: (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }),
      shot: async (name, full = false) => writeFileSync(name, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full })).data, "base64")),
      fileChoosers: () => [...fileChoosers],
      clearFileChoosers: () => { fileChoosers.length = 0; },
      waitForFileChooser: async (ms = 3000, step = "the file chooser") => {
        const end = Date.now() + ms;
        while (fileChoosers.length === 0 && Date.now() < end) await sleep(50);
        if (!fileChoosers.length) throw new Error(`timeout waiting for ${step} to open the file chooser`);
      },
      accessibleName: async () => {
        const evaluated = await send("Runtime.evaluate", { expression: "document.activeElement" });
        const objectId = evaluated.result?.objectId;
        if (!objectId) throw new Error("the focused control has no node");
        const described = await send("DOM.describeNode", { objectId });
        const backendNodeId = described.node.backendNodeId;
        await send("Accessibility.enable");
        const tree = await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
        const node = (tree.nodes ?? []).find((entry) => entry.backendDOMNodeId === backendNodeId) ?? tree.nodes?.[0];
        return { name: String(node?.name?.value ?? "").trim(), role: String(node?.role?.value ?? "") };
      },
      key: async (key) => {
        const code = key === "Tab" ? "Tab" : key === "Enter" ? "Enter" : key === " " ? "Space" : key;
        const windowsVirtualKeyCode = key === "Tab" ? 9 : key === "Enter" ? 13 : key === " " ? 32 : undefined;
        const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
      },
      close: () => {
        closing = true;
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
        stop();
        return exited;
      },
    };
  } catch (error) {
    if (!ready) stop();
    throw error;
  }
}
