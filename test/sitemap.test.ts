import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://pvmbridge.com";
const SOCIAL_IMAGE = `${ORIGIN}/img/og-bridge.png`;
const PAGE_FILES = readdirSync(ROOT)
  .filter((name) => name.endsWith(".html"))
  .sort();

function committedSitemap(): string {
  const path = new URL("../public/sitemap.xml", import.meta.url);
  assert.ok(existsSync(path), "public/sitemap.xml is stale: run node scripts/sitemap.mjs");
  return readFileSync(path, "utf8");
}

function ownAddress(file: string): string {
  return file === "index.html" ? `${ORIGIN}/` : `${ORIGIN}/${file}`;
}

function canonicalOf(file: string): string {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const found = [...html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(
    found.length,
    1,
    `${file} has ${found.length} canonical links: give it exactly one <link rel="canonical" href="${ORIGIN}/..." /> in <head>`,
  );
  const address = found[0];
  assert.ok(
    address.startsWith(`${ORIGIN}/`),
    `${file} has canonical ${address}: write the absolute ${ORIGIN}/ address of the page`,
  );
  return address;
}

function sitemapAddresses(): string[] {
  return [...committedSitemap().matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
}

function fileOfAddress(address: string): string {
  assert.ok(
    address.startsWith(`${ORIGIN}/`),
    `${address} is not under ${ORIGIN}: sitemap addresses are ${ORIGIN}/ and ${ORIGIN}/<page>.html`,
  );
  const path = address.slice(ORIGIN.length + 1);
  if (path === "") return "index.html";
  assert.ok(
    path.endsWith(".html") && !path.includes("/"),
    `${address} is not a root page address: sitemap addresses are ${ORIGIN}/ and ${ORIGIN}/<page>.html`,
  );
  return path;
}

test("public/sitemap.xml is what scripts/sitemap.mjs prints", () => {
  const run = spawnSync(process.execPath, ["scripts/sitemap.mjs", "--stdout"], { cwd: ROOT, encoding: "utf8" });
  const detail = run.stderr.split("\n").find((line) => line.trim() !== "") ?? run.error?.message ?? "no output";
  assert.equal(
    run.status,
    0,
    `public/sitemap.xml is stale: run node scripts/sitemap.mjs (the script exited ${run.status}: ${detail})`,
  );
  assert.equal(run.stdout, committedSitemap(), "public/sitemap.xml is stale: run node scripts/sitemap.mjs");
});

const SENTINEL = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>the sitemap from before the run</urlset>\n';

function configWithInputBlock(): { lines: string[]; open: number } {
  const lines = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8").split("\n");
  const open = lines.findIndex((line) => line.includes("input: {"));
  assert.notEqual(open, -1, "vite.config.ts has no input: { line: these tests edit the block it opens");
  return { lines, open };
}

// The generator finds its config and sitemap next to itself, so a run that must
// refuse needs its own tree to show it wrote nothing.
function runGeneratorOn(config: string): { status: number | null; stderr: string; sitemap: string } {
  const dir = mkdtempSync(join(tmpdir(), "sitemap-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "public"));
    copyFileSync(fileURLToPath(new URL("../scripts/sitemap.mjs", import.meta.url)), join(dir, "scripts", "sitemap.mjs"));
    writeFileSync(join(dir, "vite.config.ts"), config);
    writeFileSync(join(dir, "public", "sitemap.xml"), SENTINEL);
    const run = spawnSync(process.execPath, [join(dir, "scripts", "sitemap.mjs")], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr, sitemap: readFileSync(join(dir, "public", "sitemap.xml"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the generator refuses a page entry on the input: { opening line", () => {
  const { lines, open } = configWithInputBlock();
  lines[open] = `${lines[open]} ${lines[open + 1].trim()}`;
  lines.splice(open + 1, 1);
  const run = runGeneratorOn(lines.join("\n"));
  assert.equal(
    run.status,
    1,
    `the generator exited ${run.status}: a page entry on the input: { opening line is not read (stderr: ${run.stderr.trim()})`,
  );
  assert.match(run.stderr, /does not read entries on the opening line/);
  assert.equal(run.sitemap, SENTINEL, "the generator replaced public/sitemap.xml on a run it refused");
});

test("the generator refuses an input block that closes with anything but } or },", () => {
  const { lines, open } = configWithInputBlock();
  const close = lines.findIndex((line, index) => index > open && line.trim() === "},");
  assert.notEqual(close, -1, "vite.config.ts has no }, line after input: {");
  lines[close] += " // pages";
  const run = runGeneratorOn(lines.join("\n"));
  assert.equal(
    run.status,
    1,
    `the generator exited ${run.status}: an input block closed as }, // pages is not read (stderr: ${run.stderr.trim()})`,
  );
  assert.match(run.stderr, /closes the input block as/);
  assert.equal(run.sitemap, SENTINEL, "the generator replaced public/sitemap.xml on a run it refused");
});

test("every root page names exactly one absolute canonical", () => {
  for (const file of PAGE_FILES) {
    canonicalOf(file);
  }
});

test("each root page names its own address as canonical and og:url", () => {
  for (const file of PAGE_FILES) {
    const address = ownAddress(file);
    const canonical = canonicalOf(file);
    assert.equal(canonical, address, `${file} has canonical ${canonical}: a page's canonical is its own address, ${address}`);
    const url = /<meta property="og:url" content="([^"]*)"/.exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.ok(url, `${file} has no og:url: add <meta property="og:url" content="${address}" /> after its og:description`);
    assert.equal(url[1], address, `${file} has og:url ${url[1]}: a page's og:url is its own address, ${address}`);
  }
});

test("every sitemap address is one page's canonical and every page appears once", () => {
  const addresses = sitemapAddresses();
  const canonicals = new Map(PAGE_FILES.map((file) => [file, canonicalOf(file)]));
  for (const address of addresses) {
    const matches = [...canonicals.values()].filter((canonical) => canonical === address).length;
    assert.equal(
      matches,
      1,
      `${address} is listed in public/sitemap.xml but is the canonical of ${matches} pages: each listed address must be one page's canonical, then run node scripts/sitemap.mjs`,
    );
    assert.ok(
      existsSync(new URL(`../${fileOfAddress(address)}`, import.meta.url)),
      `${address} is in public/sitemap.xml but ${fileOfAddress(address)} does not exist: point the canonical at a real page, then run node scripts/sitemap.mjs`,
    );
  }
  for (const [file, canonical] of canonicals) {
    const listed = addresses.filter((address) => address === canonical).length;
    assert.equal(
      listed,
      1,
      `${file} says its canonical is ${canonical} but public/sitemap.xml lists it ${listed} times: run node scripts/sitemap.mjs`,
    );
  }
});

test("the root pages and the sitemap addresses name the same files", () => {
  const listed = new Map(sitemapAddresses().map((address) => [fileOfAddress(address), address]));
  for (const file of PAGE_FILES) {
    assert.ok(
      listed.has(file),
      `${file} is at the root but not in public/sitemap.xml: add it to the vite.config.ts input and run node scripts/sitemap.mjs`,
    );
  }
  for (const [file, address] of listed) {
    assert.ok(
      PAGE_FILES.includes(file),
      `${address} is in public/sitemap.xml but ${file} is not at the root: remove it from the vite.config.ts input and run node scripts/sitemap.mjs`,
    );
  }
});

test("every page carries the same social preview", () => {
  for (const file of PAGE_FILES) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const canonical = canonicalOf(file);
    const url = /<meta property="og:url" content="([^"]*)"/.exec(html);
    assert.ok(url, `${file} has no og:url: add <meta property="og:url" content="${canonical}" /> after its og:description`);
    assert.equal(url[1], canonical, `${file} has og:url ${url[1]} but canonical ${canonical}: make them the same address`);
    const image = /<meta property="og:image" content="([^"]*)"/.exec(html);
    assert.ok(image, `${file} has no og:image: add <meta property="og:image" content="${SOCIAL_IMAGE}" /> after its og:description`);
    assert.equal(image[1], SOCIAL_IMAGE, `${file} has og:image ${image[1]}: point it at ${SOCIAL_IMAGE}`);
    const card = /<meta name="twitter:card" content="([^"]*)"/.exec(html);
    assert.ok(card, `${file} has no twitter:card: add <meta name="twitter:card" content="summary_large_image" /> after its og:description`);
    assert.equal(card[1], "summary_large_image", `${file} has twitter:card ${card[1]}: use summary_large_image for a 1200 by 630 image`);
  }
});

test("the social image is a 1200 by 630 PNG under the size limit", () => {
  const path = new URL("../public/img/og-bridge.png", import.meta.url);
  assert.ok(existsSync(path), "public/img/og-bridge.png is missing: run npm run build && npm run smoke:preview -- --gallery");
  const bytes = statSync(path).size;
  assert.ok(bytes < 150_000, `public/img/og-bridge.png is ${bytes} bytes, over the 150,000 limit: render it smaller`);
  const png = readFileSync(path);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "public/img/og-bridge.png is not a PNG: run npm run build && npm run smoke:preview -- --gallery",
  );
  assert.equal(png.readUInt32BE(16), 1200, "public/img/og-bridge.png is not 1200 pixels wide: run npm run build && npm run smoke:preview -- --gallery");
  assert.equal(png.readUInt32BE(20), 630, "public/img/og-bridge.png is not 630 pixels tall: run npm run build && npm run smoke:preview -- --gallery");
});
