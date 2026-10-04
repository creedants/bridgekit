// Cloudflare limits a single file to 25 MiB; the database engine files are
// larger. Replaces each dist/assets/*.wasm with a gzipped copy, which
// server/assets.ts serves with Content-Encoding: gzip.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync, constants } from "node:zlib";

const dir = new URL("../dist/assets/", import.meta.url);
for (const name of readdirSync(dir).filter((n) => n.endsWith(".wasm"))) {
  const file = new URL(name, dir);
  const packed = gzipSync(readFileSync(file), { level: constants.Z_BEST_COMPRESSION });
  writeFileSync(new URL(name + ".gz", dir), packed);
  rmSync(file);
  console.log(`${name}: ${(packed.length / 2 ** 20).toFixed(1)} MiB gzipped`);
}
