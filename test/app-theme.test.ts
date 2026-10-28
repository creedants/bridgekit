import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INK } from "../src/app/report.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const TOKENS = withoutComments(read("src/tokens.css"));
const HOME = withoutComments(read("src/site/home.css"));
const STYLES = withoutComments(read("src/app/styles.css"));
const REPORT = read("src/app/report.ts");
const HOME_PAGE = read("index.html");
const APP_PAGE = read("app/index.html");

const BRAND = ["--sun", "--plum", "--plum-2", "--blush", "--paper"];
const OLD_PALETTE = ["#1f4b99", "#183b7a", "#eaf0fa", "#14181f", "#4a5360", "#dde1e6", "#c4cad3", "#f5f6f8", "#e6e9ed"];

/** The custom properties declared in every top-level `selector { ... }` block of a stylesheet. */
function vars(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const block of css.matchAll(new RegExp(`(?:^|[{};\\s])${escaped}\\s*\\{([^}]*)\\}`, "g"))) {
    for (const declaration of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(declaration[1], declaration[2].trim());
    }
  }
  return found;
}

/** Follows `var(--x)` through one file's properties to the value it ends at, with hex lower-cased. */
function resolve(file: string, properties: Map<string, string>, name: string): string {
  let value = properties.get(name);
  const seen = new Set([name]);
  let ref: RegExpExecArray | null;
  while (value !== undefined && (ref = /^var\((--[\w-]+)\)$/.exec(value))) {
    assert.ok(!seen.has(ref[1]), `${file} ${name} refers to itself through ${ref[1]}`);
    seen.add(ref[1]);
    value = properties.get(ref[1]);
  }
  assert.ok(value !== undefined, `${file} has no value for ${name}`);
  return value.toLowerCase();
}

const TOOL = vars(TOKENS, ":root");
const tool = (name: string) => resolve("src/tokens.css", TOOL, name);
const HOME_ROOT = vars(HOME, ":root");
const HERO = new Map([...HOME_ROOT, ...vars(HOME, ".hero")]);

test("the tool's brand colours equal the home page's", () => {
  for (const name of BRAND) {
    const home = HOME_ROOT.get(name);
    assert.ok(home, `src/site/home.css :root has no ${name}`);
    assert.equal(
      TOOL.get(name)?.toLowerCase(),
      home.toLowerCase(),
      `src/tokens.css ${name} is ${TOOL.get(name)} but src/site/home.css ${name} is ${home}: the brand palette lives in both; change both`,
    );
  }
});

test("the home page's picture of the tool uses the tool's colours", () => {
  const pictured = [...HERO.keys()].filter((name) => name.startsWith("--t-"));
  assert.ok(pictured.length > 0, "src/site/home.css .hero declares no --t-* colours");
  for (const name of pictured) {
    const role = `--${name.slice("--t-".length)}`;
    assert.ok(TOOL.has(role), `src/site/home.css .hero ${name} has no ${role} in src/tokens.css: picture only colours the tool has`);
    assert.equal(
      resolve("src/site/home.css", HERO, name),
      tool(role),
      `src/site/home.css .hero ${name} differs from src/tokens.css ${role}: keep the picture in step with the tool`,
    );
  }
});

test("the report's colours equal the tool's", () => {
  for (const [key, value] of Object.entries(INK)) {
    assert.ok(TOOL.has(`--${key}`), `src/app/report.ts INK.${key} names no --${key} in src/tokens.css: key INK by role name`);
    assert.equal(value.toLowerCase(), tool(`--${key}`), `src/app/report.ts INK.${key} is ${value} but src/tokens.css --${key} is ${tool(`--${key}`)}`);
  }
});

test("the picture's drawing uses no colour the tool does not", () => {
  const start = HOME_PAGE.indexOf('<a class="frame"');
  assert.ok(start >= 0, 'index.html has no <a class="frame"> picture of the tool');
  const frame = HOME_PAGE.slice(start, HOME_PAGE.indexOf("</a>", start));
  const palette = new Set([...TOOL.keys()].map(tool));
  const painted = [...frame.matchAll(/\b(fill|stroke)="(#[0-9a-fA-F]{3,6})"/g)];
  assert.ok(painted.length > 0, "index.html's picture has no fill or stroke colours to check");
  for (const [, attribute, hex] of painted) {
    const colour = hex.toLowerCase();
    if (colour === "#fff" || colour === "#ffffff" || palette.has(colour)) continue;
    assert.ok(
      HOME.includes(`[${attribute}="${hex}"]`),
      `index.html's picture draws ${attribute}="${hex}", which is not a src/tokens.css colour: restate it in src/site/home.css with a .hero [${attribute}="${hex}"] rule`,
    );
  }
});

test("the tool loads Instrument Sans from this site, as the home page does", () => {
  const face = (css: string, file: string) => {
    const block = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).find((b) => /Instrument Sans/.test(b));
    assert.ok(block, `${file} has no Instrument Sans @font-face`);
    const field = (name: string) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)?.[1].replaceAll('"', "").trim();
    return { family: field("font-family"), src: field("src"), weight: field("font-weight"), style: field("font-style"), display: field("font-display") };
  };
  const ours = face(TOKENS, "src/tokens.css");
  assert.equal(ours.src, 'url(/fonts/instrument-sans.woff2) format(woff2)', "src/tokens.css loads Instrument Sans from somewhere other than /fonts/instrument-sans.woff2");
  assert.deepEqual(ours, face(HOME, "src/site/home.css"), "src/tokens.css and src/site/home.css declare Instrument Sans differently: keep one font file cached across pages");
  const preload = [...APP_PAGE.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes('href="/fonts/instrument-sans.woff2"'));
  assert.ok(preload, "app/index.html does not preload /fonts/instrument-sans.woff2");
  assert.match(preload, /rel="preload"/, "app/index.html's font link is not rel=preload");
  assert.match(preload, /as="font"/, "app/index.html's font preload has no as=font");
  assert.match(preload, /\scrossorigin\b/, "app/index.html's font preload has no crossorigin, so the browser fetches the font twice");
});

test("the tool uses no colour of the old palette", () => {
  for (const [file, text] of [["src/tokens.css", TOKENS], ["src/app/styles.css", STYLES], ["src/app/report.ts", REPORT]]) {
    for (const old of OLD_PALETTE) {
      assert.ok(!text.toLowerCase().includes(old), `${file} still uses the old palette colour ${old}`);
    }
  }
  const brand = /var\(--(sun|plum|plum-2|blush|paper)\)/.exec(STYLES);
  assert.equal(brand, null, `src/app/styles.css uses ${brand?.[0]}: style with role tokens such as --text or --accent, not brand colours`);
});
