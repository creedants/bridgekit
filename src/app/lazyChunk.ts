// Code the page fetches later, and when it is worth fetching.
// The loader keeps one load per chunk and retries a failed address; the scheduler waits for the page to go idle.

const IDLE_CAP_MS = 2000;

/**
 * Runs work nobody has asked for yet: after the load event, on an idle
 * callback, then `settleMs` later. Save-Data schedules nothing.
 * Returns a cancel.
 */
export function scheduleSpeculative(work: () => void, settleMs = 0): () => void {
  if (networkSaveData()) return () => {};
  let cancelled = false;
  let idleId: number | undefined;
  let timerId: number | undefined;
  const settle = () => {
    if (cancelled) return;
    if (settleMs === 0) work();
    else timerId = window.setTimeout(work, settleMs);
  };
  const whenIdle = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(settle, { timeout: IDLE_CAP_MS });
      return;
    }
    timerId = window.setTimeout(settle, IDLE_CAP_MS);
  };
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", whenIdle);
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    if (timerId !== undefined) window.clearTimeout(timerId);
  };
}

// The DOM lib in this toolchain does not declare Network Information.
function networkSaveData(): boolean {
  const host: unknown = navigator;
  if (typeof host !== "object" || host === null || !("connection" in host)) return false;
  const connection = host.connection;
  if (typeof connection !== "object" || connection === null || !("saveData" in connection)) return false;
  return connection.saveData === true;
}

type ChunkFailure = "network" | "gone";

export type ChunkSentences = Readonly<Record<ChunkFailure, string>>;

interface ChunkSource<T> {
  /** Written inline as one literal import(). The retry reads the chunk URL from this function's text. */
  importer: () => Promise<unknown>;
  parse: (module: unknown) => T | undefined;
  /**
   * Reads a fresh copy of the chunk at an address the browser has not cached as
   * failed. The default is the build's chunk address plus a retry stamp.
   */
  freshCopy?: (stamp: string) => Promise<unknown>;
}

export interface LazyChunk<T> {
  /** One shared load per chunk. Rejects only with an Error whose message is one of the two sentences. */
  load(): Promise<T>;
  readonly loaded: T | undefined;
  /** Calls `listener` with the value of every load that resolves. Returns an unsubscribe. */
  subscribe(listener: (value: T) => void): () => void;
}

type ChunkState<T> =
  | { phase: "untried" }
  | { phase: "failed" }
  | { phase: "loading"; attempt: Promise<T> }
  | { phase: "loaded"; attempt: Promise<T>; value: T };

type ChunkResult<T> = { value: T } | { failure: ChunkFailure };

export class ChunkUnavailable extends Error {}

/** A dynamic chunk that recovers from a failed load. */
export function lazyChunk<T>(options: ChunkSource<T> & { sentences: ChunkSentences }): LazyChunk<T> {
  let state: ChunkState<T> = { phase: "untried" };
  const listeners = new Set<(value: T) => void>();
  return {
    load() {
      if (state.phase === "loading" || state.phase === "loaded") return state.attempt;
      const reading = state.phase === "failed" ? retriedChunk(options) : firstChunk(options);
      const attempt: Promise<T> = reading.then((result) => {
        if ("failure" in result) {
          state = { phase: "failed" };
          throw new ChunkUnavailable(options.sentences[result.failure]);
        }
        state = { phase: "loaded", attempt, value: result.value };
        for (const listener of listeners) listener(result.value);
        return result.value;
      });
      state = { phase: "loading", attempt };
      return attempt;
    },
    get loaded() {
      return state.phase === "loaded" ? state.value : undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function parsedChunk<T>(source: ChunkSource<T>, module: unknown): ChunkResult<T> {
  const value = source.parse(module);
  return value === undefined ? { failure: "gone" } : { value };
}

async function firstChunk<T>(source: ChunkSource<T>): Promise<ChunkResult<T>> {
  try {
    return parsedChunk(source, await source.importer());
  } catch {
    return { failure: "network" };
  }
}

let retryAttempts = 0;

// Chromium keeps a failed import failed for that URL for the life of the page.
async function retriedChunk<T>(source: ChunkSource<T>): Promise<ChunkResult<T>> {
  retryAttempts += 1;
  const stamp = Date.now() + "." + retryAttempts;
  if (source.freshCopy) {
    try {
      return parsedChunk(source, await source.freshCopy(stamp));
    } catch {
      return { failure: "network" };
    }
  }
  const url = chunkUrl(source.importer);
  if (url === null) return { failure: "gone" };
  const retryUrl = url + "?retry=" + stamp;
  try {
    if (!(await servedAsJavaScript(retryUrl))) return { failure: "gone" };
    const module: unknown = await import(/* @vite-ignore */ retryUrl);
    return parsedChunk(source, module);
  } catch {
    return { failure: "network" };
  }
}

async function servedAsJavaScript(url: string): Promise<boolean> {
  const response = await fetch(url, { cache: "no-store", redirect: "manual" });
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok || contentType.includes("text/html") || !isJavaScriptContentType(contentType)) return false;
  return !(await bodyStartsWithMarkup(response));
}

const IMPORT_SPECIFIER = /\bimport\(\s*(["'`])([^"'`\\$]+)\1\s*\)/g;
const CHUNK_PATH = /^\/assets\/[A-Za-z0-9_.-]+\.js$/;

// The build writes the chunk's file name into the importer as a literal, and
// a leaf chunk gets no modulepreload link to read it from.
function chunkUrl(importer: () => Promise<unknown>): string | null {
  const specifiers = [...Function.prototype.toString.call(importer).matchAll(IMPORT_SPECIFIER)];
  if (specifiers.length !== 1) return null;
  let parsed: URL;
  try {
    parsed = new URL(specifiers[0][2], import.meta.url);
  } catch {
    return null;
  }
  if (!CHUNK_PATH.test(parsed.pathname) || parsed.search !== "" || parsed.hash !== "") return null;
  if (typeof location === "undefined") return null;
  if (parsed.origin !== location.origin) return null;
  return parsed.origin + parsed.pathname;
}

function isJavaScriptContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  return mediaType === "text/javascript" || mediaType === "application/javascript";
}

async function bodyStartsWithMarkup(response: Response): Promise<boolean> {
  const body = response.body;
  if (body === null) return false;
  const reader = body.getReader();
  try {
    const chunk = await reader.read();
    const bytes = chunk.value;
    if (bytes === undefined || bytes.length === 0) return false;
    return new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("<");
  } finally {
    void reader.cancel().catch(() => {});
  }
}
