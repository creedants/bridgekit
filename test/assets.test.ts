import assert from "node:assert/strict";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import { serveCompressedWasm } from "../server/assets.ts";

const raw = Buffer.from(`bridgekit wasm fixture\n${"abcdefghijklmnopqrstuvwxyz".repeat(80)}`);
const gzip = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
const brotli = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
});

function assets(): Fetcher {
  const files = new Map<string, Uint8Array>([
    ["/assets/duckdb-eh.wasm.gz", gzip],
    ["/assets/duckdb-eh.wasm.br", brotli],
  ]);
  return {
    async fetch(input) {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      const body = files.get(path);
      if (!body) return new Response("missing", { status: 404 });
      const copy = new ArrayBuffer(body.byteLength);
      new Uint8Array(copy).set(body);
      return new Response(copy);
    },
  };
}

function request(accept: string | null, clientAcceptEncoding?: string): Request {
  const headers = new Headers();
  if (accept !== null) headers.set("accept-encoding", accept);
  const req = new Request("https://bridgekit.test/assets/duckdb-eh.wasm", { headers });
  if (clientAcceptEncoding !== undefined) Object.assign(req, { cf: { clientAcceptEncoding } });
  return req;
}

async function body(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

test("brotli, gzip, and identity each return the original wasm bytes", async () => {
  const brotliResponse = await serveCompressedWasm(request("br"), assets());
  const gzipResponse = await serveCompressedWasm(request("gzip"), assets());
  const plainResponse = await serveCompressedWasm(request(null), assets());

  assert.equal(brotliResponse.status, 200);
  assert.equal(brotliResponse.headers.get("content-type"), "application/wasm");
  assert.equal(brotliResponse.headers.get("content-encoding"), "br");
  assert.equal(brotliResponse.headers.get("cache-control"), "public, max-age=31536000, immutable, no-transform");
  assert.equal(brotliResponse.headers.get("vary"), "accept-encoding");
  const brotliBytes = await body(brotliResponse);
  assert.deepEqual(brotliBytes, brotli);
  assert.deepEqual(brotliDecompressSync(brotliBytes), raw);

  assert.equal(gzipResponse.status, 200);
  assert.equal(gzipResponse.headers.get("content-type"), "application/wasm");
  assert.equal(gzipResponse.headers.get("content-encoding"), "gzip");
  const gzipBytes = await body(gzipResponse);
  assert.deepEqual(gzipBytes, gzip);
  assert.deepEqual(gunzipSync(gzipBytes), raw);

  assert.equal(plainResponse.status, 200);
  assert.equal(plainResponse.headers.get("content-type"), "application/wasm");
  assert.equal(plainResponse.headers.get("content-encoding"), null);
  assert.deepEqual(await body(plainResponse), raw);
});

test("a browser Accept-Encoding picks brotli, and a refused brotli falls back to gzip", async () => {
  const chrome = await serveCompressedWasm(request("gzip, deflate, br, zstd"), assets());
  const gzipOnly = await serveCompressedWasm(request("br;q=0, gzip"), assets());
  const gzipPreferred = await serveCompressedWasm(request("br;q=0.1, gzip;q=0.8"), assets());

  assert.equal(chrome.headers.get("content-encoding"), "br");
  assert.deepEqual(brotliDecompressSync(await body(chrome)), raw);
  assert.equal(gzipOnly.headers.get("content-encoding"), "gzip");
  assert.deepEqual(gunzipSync(await body(gzipOnly)), raw);
  assert.equal(gzipPreferred.headers.get("content-encoding"), "gzip");
  assert.deepEqual(gunzipSync(await body(gzipPreferred)), raw);
});

test("Cloudflare's rewritten Accept-Encoding loses to request.cf.clientAcceptEncoding", async () => {
  const gzipClient = await serveCompressedWasm(request("br, gzip", "gzip"), assets());
  const plainClient = await serveCompressedWasm(request("br, gzip", ""), assets());

  assert.equal(gzipClient.headers.get("content-encoding"), "gzip");
  assert.deepEqual(gunzipSync(await body(gzipClient)), raw);
  assert.equal(plainClient.headers.get("content-encoding"), null);
  assert.deepEqual(await body(plainClient), raw);
});

test("a missing engine file is a 404", async () => {
  const response = await serveCompressedWasm(
    new Request("https://bridgekit.test/assets/missing.wasm", { headers: { "accept-encoding": "br" } }),
    assets(),
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});
