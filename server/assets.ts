import type { Fetcher } from "./cloudflare.ts";

/**
 * The engine files are larger than Cloudflare's 25 MiB per-file limit, so the
 * Cloudflare build stores a Brotli copy and a gzip copy
 * (scripts/compress-wasm.mjs) and removes the original. Brotli is what a
 * current browser accepts. Gzip covers clients that do not. A client that
 * accepts neither gets the gzip copy unpacked.
 *
 * Cloudflare replaces Accept-Encoding with "br, gzip" before the Worker runs.
 * The browser's own header is request.cf.clientAcceptEncoding.
 */
const headers = {
  "content-type": "application/wasm",
  // Cloudflare compresses application/wasm on its own. no-transform keeps these bytes.
  "cache-control": "public, max-age=31536000, immutable, no-transform",
  "vary": "accept-encoding",
  "x-content-type-options": "nosniff",
};

type Coding = "br" | "gzip";

const fileSuffix: Record<Coding, string> = { br: "br", gzip: "gz" };

function clientAcceptEncoding(request: Request): string | null {
  const cf = (request as { cf?: { clientAcceptEncoding?: string | null } }).cf;
  if (cf && typeof cf.clientAcceptEncoding === "string") return cf.clientAcceptEncoding;
  return request.headers.get("accept-encoding");
}

/** br on a tie, because that file is smaller. q=0 means the client refused it. */
function preferredCoding(header: string | null): Coding | null {
  if (!header) return null;
  let br = -1;
  let gzip = -1;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== "br" && name !== "gzip") continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value);
      quality = Number.isFinite(parsed) ? parsed : 0;
    }
    if (quality <= 0) continue;
    if (name === "br") br = Math.max(br, quality);
    else gzip = Math.max(gzip, quality);
  }
  if (br < 0 && gzip < 0) return null;
  return br >= gzip ? "br" : "gzip";
}

export async function serveCompressedWasm(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  const chosen = preferredCoding(clientAcceptEncoding(request));
  const stored = await assets.fetch(new URL(`${url.pathname}.${fileSuffix[chosen ?? "gzip"]}`, url).toString());
  if (!stored.ok || !stored.body) return new Response("Not found", { status: 404 });
  if (!chosen) return new Response(stored.body.pipeThrough(new DecompressionStream("gzip")), { headers });
  // manual keeps the runtime from compressing bytes that are already compressed.
  return new Response(stored.body, {
    headers: { ...headers, "content-encoding": chosen },
    encodeBody: "manual",
  } as ResponseInit);
}
