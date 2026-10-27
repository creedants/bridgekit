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
  const files = [];
  let depth = 1;
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index];
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) break;
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
  const addresses = pagesInConfig()
    .filter((file) => !EXCLUDED.has(file))
    .map(addressOf)
    .sort();
  const urls = addresses.map((address) => `  <url><loc>${address}</loc></url>\n`).join("");
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
