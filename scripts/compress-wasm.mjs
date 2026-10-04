// Cloudflare limits one static file to 25 MiB. The engine files are larger.
// Stores a maximum-quality Brotli copy and a best-gzip copy, checks that both
// decompress to the original, then removes the original. server/assets.ts
// picks the copy from the client's Accept-Encoding.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from "node:zlib";

const limit = 25 * 1024 * 1024;
const dir = new URL("../dist/assets/", import.meta.url);

for (const name of readdirSync(dir).filter((n) => n.endsWith(".wasm"))) {
  const file = new URL(name, dir);
  const raw = readFileSync(file);
  const gzip = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
  const brotli = brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  if (gzip.length >= limit || brotli.length >= limit) {
    throw new Error(`${name} is still at least 25 MiB after compression (gzip ${gzip.length}, brotli ${brotli.length})`);
  }
  if (!gunzipSync(gzip).equals(raw) || !brotliDecompressSync(brotli).equals(raw)) {
    throw new Error(`${name} did not decompress back to the original bytes`);
  }
  writeFileSync(new URL(`${name}.gz`, dir), gzip);
  writeFileSync(new URL(`${name}.br`, dir), brotli);
  rmSync(file);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  console.log(`${name}: raw ${raw.length} sha256 ${sha256} gzip ${gzip.length} brotli ${brotli.length}`);
}
