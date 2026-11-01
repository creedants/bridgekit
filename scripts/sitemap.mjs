import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ORIGIN = "https://pvmbridge.com";
const CONFIG = new URL("../vite.config.ts", import.meta.url);
const SITEMAP = new URL("../public/sitemap.xml", import.meta.url);
const KNOWN_SPREAD = '...(env.VITE_WORKSPACES === "1" ? { pay: resolve(import.meta.dirname, "pay/index.html") } : {})';

/**
 * Build inputs deliberately omitted from this sitemap. The app has no canonical
 * in this change, and pay belongs to Part 2. Sitemap exclusion does not block
 * crawling or indexing.
 */
const EXCLUDED = new Map([
  // app/index.html is a client-rendered shell with no description, and it is
  // outside the files this ticket may change, so it cannot carry a canonical.
  ["app/index.html", "client-rendered tool shell, no description, and app/index.html cannot carry a canonical from this ticket"],
  // pay/index.html ships only when VITE_WORKSPACES=1, and Part 2 owns its copy.
  ["pay/index.html", "Part 2 build only"],
]);

// A page's date changes when its content does, and must match the date line the page shows.
const LASTMOD = new Map([
  ["index.html", "2026-10-31"],
  ["method.html", "2026-10-31"],
  ["guide.html", "2026-10-31"],
  ["price-volume-mix-analysis.html", "2026-10-31"],
  ["grouping-level.html", "2026-10-31"],
  ["privacy.html", "2026-10-28"],
  ["terms.html", "2026-10-28"],
]);

/** The one place the naming rule lives. */
function addressOf(file) {
  if (file === "index.html") return `${ORIGIN}/`;
  if (file === "app/index.html") return `${ORIGIN}/app/`;
  if (/^[a-z0-9-]+\.html$/.test(file)) return `${ORIGIN}/${file}`;
  throw new Error(`${file} has no address: index.html is ${ORIGIN}/, app/index.html is ${ORIGIN}/app/, and <name>.html is ${ORIGIN}/<name>.html`);
}

function pagesInConfig() {
  const lines = readFileSync(CONFIG, "utf8").split("\n");
  const open = lines.findIndex((line) => line.includes("input: {"));
  if (open === -1) throw new Error("vite.config.ts has no input: { block to read pages from");
  const afterOpen = lines[open].slice(lines[open].indexOf("input: {") + "input: {".length).trim();
  if (afterOpen !== "") {
    throw new Error(`vite.config.ts line ${open + 1} has ${afterOpen} after input: {; scripts/sitemap.mjs does not read entries on the opening line, so put every page on its own line`);
  }
  const files = [];
  let depth = 1;
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index];
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      const closing = line.trim();
      if (closing !== "}" && closing !== "},") {
        throw new Error(`vite.config.ts line ${index + 1} closes the input block as ${closing}; scripts/sitemap.mjs reads only } or }, on the closing line`);
      }
      break;
    }
    const entry = line.trim();
    if (entry === "" || entry === KNOWN_SPREAD || entry === `${KNOWN_SPREAD},`) continue;
    const match = /^\w+: resolve\(import\.meta\.dirname, "([^"]+\.html)"\),$/.exec(entry);
    if (!match) {
      throw new Error(`vite.config.ts input line ${index + 1} not understood: ${entry}; teach scripts/sitemap.mjs this shape`);
    }
    files.push(match[1]);
  }
  if (files.length === 0) throw new Error("vite.config.ts input lists no pages: check the input block or teach scripts/sitemap.mjs this shape");
  return files;
}

function sitemap() {
  const pages = pagesInConfig()
    .filter((file) => !EXCLUDED.has(file))
    .map((file) => ({ file, address: addressOf(file) }))
    .sort((left, right) => (left.address < right.address ? -1 : 1));
  for (const { file } of pages) {
    const date = LASTMOD.get(file);
    if (date === undefined) {
      throw new Error(`${file} has no last-modified date: add ["${file}", "YYYY-MM-DD"] to LASTMOD in scripts/sitemap.mjs, the day its content last changed`);
    }
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`${file} has last-modified date ${date}, which is not a real YYYY-MM-DD calendar date: fix its entry in LASTMOD in scripts/sitemap.mjs`);
    }
  }
  for (const file of LASTMOD.keys()) {
    if (pages.some((page) => page.file === file)) continue;
    throw new Error(`${file} has a last-modified date but the sitemap does not include it: remove its entry from LASTMOD in scripts/sitemap.mjs, or add the page to the vite.config.ts input`);
  }
  const addresses = pages.map((page) => page.address);
  const urls = pages.map(({ file, address }) => `  <url><loc>${address}</loc><lastmod>${LASTMOD.get(file)}</lastmod></url>\n`).join("");
  return {
    addresses,
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>\n`,
  };
}

try {
  const { addresses, xml } = sitemap();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(xml);
  } else if (existsSync(SITEMAP) && readFileSync(SITEMAP, "utf8") === xml) {
    console.log(`sitemap: ${addresses.length} pages, unchanged`);
  } else {
    writeFileSync(SITEMAP, xml);
    console.log(`sitemap: ${addresses.length} pages, written`);
  }
} catch (error) {
  console.error(`sitemap: ${error.message}`);
  process.exit(1);
}
