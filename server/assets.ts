import type { Fetcher } from "./cloudflare.ts";

/**
 * The two database engine files are 36 MB and 41 MB, over Cloudflare's 25 MiB
 * limit per file, so the Cloudflare build stores them gzipped
 * (scripts/compress-wasm.mjs) and this sends them on with the matching
 * Content-Encoding. A client that does not accept gzip gets them unpacked.
 */
export async function serveCompressedWasm(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  const stored = await assets.fetch(new URL(url.pathname + ".gz", url).toString());
  if (!stored.ok || !stored.body) return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": "application/wasm",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  if (/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
    // "manual" passes the bytes through as stored instead of compressing them again.
    return new Response(stored.body, { headers: { ...headers, "content-encoding": "gzip" }, encodeBody: "manual" } as ResponseInit);
  }
  return new Response(stored.body.pipeThrough(new DecompressionStream("gzip")), { headers });
}
