import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const ORIGIN = "https://pvmbridge.com";
const APP_TITLE = "Price-volume-mix bridge tool | PVM Bridge";
const APP_DESCRIPTION =
  "A price-volume-mix bridge that works across several product attributes at once. Runs in your browser, so your sales file is never uploaded. Free and open source.";
const TERMS_DESCRIPTION =
  "The terms for using PVM Bridge: the free tool, the open-source license, what we provide and what we do not, and how to contact us.";
const PRO_FEATURES = [
  "Saved workspaces across devices",
  "Shared setups for a team",
  "AI commentary on each bridge",
  "PowerPoint export",
];

type Page = { file: string; address: string };

const PAGES: Page[] = [
  { file: "index.html", address: `${ORIGIN}/` },
  { file: "guide.html", address: `${ORIGIN}/guide.html` },
  { file: "method.html", address: `${ORIGIN}/method.html` },
  { file: "privacy.html", address: `${ORIGIN}/privacy.html` },
  { file: "terms.html", address: `${ORIGIN}/terms.html` },
  {
    file: "price-volume-mix-analysis.html",
    address: `${ORIGIN}/price-volume-mix-analysis.html`,
  },
  { file: "grouping-level.html", address: `${ORIGIN}/grouping-level.html` },
  { file: "app/index.html", address: `${ORIGIN}/app/` },
];

const ROOT_PAGES = PAGES.filter((page) => !page.file.includes("/"));
const IMAGE_PAGES = ["guide.html"];

function readPage(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

type PlanCard = { attributes: Map<string, string>; inner: string };

function classTokensOf(attributes: Map<string, string>): string[] {
  return (attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const FEATURE_BLOCK = /<!-- feature:!?[a-z-]+ -->[\s\S]*?<!-- \/feature:[a-z-]+ -->/g;

function visibleWordsOf(html: string): string[] {
  const withoutHead = html.replace(/<head>[\s\S]*?<\/head>/i, " ");
  const withoutFeatures = withoutHead.replace(FEATURE_BLOCK, " ");
  const withoutComments = withoutFeatures.replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutComments.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return collapseSpaces(decoded).split(" ").filter(Boolean);
}

function planCardsOf(html: string): PlanCard[] {
  const cards: Array<PlanCard & { start: number }> = [];
  const open: Array<{ start: number; innerStart: number; tag: string }> = [];
  for (const match of html.matchAll(/<(\/?)div\b[^>]*>/gi)) {
    const start = match.index ?? 0;
    if (match[1] === "/") {
      const card = open.pop();
      if (card === undefined) continue;
      const attributes = attributesOf(card.tag);
      if (!classTokensOf(attributes).includes("plan")) continue;
      cards.push({
        start: card.start,
        attributes,
        inner: html.slice(card.innerStart, start),
      });
    } else {
      open.push({ start, innerStart: start + match[0].length, tag: match[0] });
    }
  }
  return cards
    .sort((left, right) => left.start - right.start)
    .map(({ attributes, inner }) => ({ attributes, inner }));
}

function plannedFeaturesOf(html: string, label: string): string[] {
  const card = planCardsOf(html).find((candidate) =>
    [...candidate.inner.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].some(
      (span) => {
        const tokens = classTokensOf(attributesOf(span[0]));
        return (
          tokens.includes("tag") &&
          tokens.includes("muted") &&
          collapseSpaces(span[1]) === "Planned"
        );
      },
    ),
  );
  if (card === undefined) {
    throw new Error(
      `${label} has no plan card that says Planned: keep the <div class="plan"> whose <span class="tag muted"> reads Planned`,
    );
  }
  const list = /<ul\b[^>]*>([\s\S]*?)<\/ul>/i.exec(card.inner);
  if (list === null) {
    throw new Error(
      `${label} has a plan card that says Planned but no <ul>: keep one list of the planned features in it`,
    );
  }
  return [...list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) =>
    collapseSpaces(item[1]),
  );
}

function headOf(file: string, html: string): string {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html);
  assert.ok(head, `${file} has no <head>: add the page head block`);
  return head[1];
}

function titlesOf(html: string): string[] {
  return [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) =>
    match[1].trim(),
  );
}

function descriptionsOf(html: string): string[] {
  return [...html.matchAll(/<meta\s+name="description"\s+content="([^"]*)"/g)].map(
    (match) => match[1].trim(),
  );
}

function canonicalsOf(html: string): string[] {
  return [
    ...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"/g),
  ].map((match) => match[1].trim());
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/\s([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

function pngSizeOf(file: string, src: string): { width: number; height: number } {
  assert.ok(
    src.startsWith("/img/") && src.endsWith(".png"),
    `${file} has an image src ${src}: point it at a PNG under /img/`,
  );
  const path = new URL(`../public${src}`, import.meta.url);
  assert.ok(
    existsSync(path),
    `${file} points at ${src}, which is missing: add the PNG under public${src}`,
  );
  const png = readFileSync(path);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("every page names one title, one description and one canonical", () => {
  for (const page of PAGES) {
    const head = headOf(page.file, readPage(page.file));
    const titles = titlesOf(head);
    assert.equal(
      titles.length,
      1,
      `${page.file} has ${titles.length} <title> elements in <head>: give it exactly one <title>`,
    );
    const descriptions = descriptionsOf(head);
    assert.equal(
      descriptions.length,
      1,
      `${page.file} has ${descriptions.length} <meta name="description"> elements in <head>: give it exactly one`,
    );
    const canonicals = canonicalsOf(head);
    assert.equal(
      canonicals.length,
      1,
      `${page.file} has ${canonicals.length} canonical links in <head>: give it exactly one <link rel="canonical" href="${page.address}" />`,
    );
    assert.equal(
      canonicals[0],
      page.address,
      `${page.file} has canonical ${canonicals[0]} but its address is ${page.address}: make them the same address`,
    );
  }
});

test("every page has its own title and every root page its own description", () => {
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const page of PAGES) {
    const head = headOf(page.file, readPage(page.file));
    const title = titlesOf(head)[0];
    const titleOwner = titles.get(title);
    assert.ok(
      titleOwner === undefined,
      `${page.file} shares its title "${title}" with ${titleOwner}: write a title that names this page`,
    );
    titles.set(title, page.file);

    // The app page repeats the home page description by contract, so only the
    // root pages must each say something of their own.
    if (page.file.includes("/")) continue;
    const description = descriptionsOf(head)[0];
    assert.ok(
      typeof description === "string" && description.trim() !== "",
      `${page.file} has no <meta name="description"> content: describe the page in one sentence`,
    );
    const descriptionOwner = descriptions.get(description);
    assert.ok(
      descriptionOwner === undefined,
      `${page.file} shares its description with ${descriptionOwner}: describe this page in its own sentence`,
    );
    descriptions.set(description, page.file);
  }
});

test("the app page carries the tool contract strings", () => {
  const head = headOf("app/index.html", readPage("app/index.html"));
  assert.equal(
    titlesOf(head)[0],
    APP_TITLE,
    `app/index.html title is "${titlesOf(head)[0]}" but should be "${APP_TITLE}": use the tool title`,
  );
  assert.equal(
    descriptionsOf(head)[0],
    APP_DESCRIPTION,
    `app/index.html description does not match the tool description: use "${APP_DESCRIPTION}"`,
  );
});

test("the gallery images declare their size, live in a picture and have AVIF sources", () => {
  for (const file of IMAGE_PAGES) {
    const html = readPage(file);
    const images = [...html.matchAll(/<img\b[^>]*>/g)];
    assert.ok(images.length > 0, `${file} has no <img> elements: add its gallery images`);
    for (const image of images) {
      const attributes = attributesOf(image[0]);
      const src = attributes.get("src") ?? "";
      const alt = attributes.get("alt");
      assert.ok(
        alt !== undefined && alt.trim() !== "",
        `${file} has an image ${src} with no alt text: write what the image shows`,
      );
      assert.equal(
        attributes.get("decoding"),
        "async",
        `${file} has an image ${src} without decoding="async": add it to the <img>`,
      );
      if (file === "guide.html") {
        assert.equal(
          attributes.get("loading"),
          "lazy",
          `${file} has an image ${src} without loading="lazy": add it to the <img>`,
        );
      }
      const size = pngSizeOf(file, src);
      assert.equal(
        attributes.get("width"),
        String(size.width),
        `${file} has an image ${src} with width ${attributes.get("width") ?? "missing"} but the PNG is ${size.width} pixels wide: set width="${size.width}"`,
      );
      assert.equal(
        attributes.get("height"),
        String(size.height),
        `${file} has an image ${src} with height ${attributes.get("height") ?? "missing"} but the PNG is ${size.height} pixels tall: set height="${size.height}"`,
      );

      const index = image.index;
      const open = html.lastIndexOf("<picture>", index);
      const close = html.indexOf("</picture>", index);
      assert.ok(
        open !== -1 &&
          close !== -1 &&
          open < index &&
          html.lastIndexOf("</picture>", index) < open,
        `${file} has an image ${src} outside a <picture>: wrap it in <picture> with a <source type="image/avif" srcset="/img/....avif" />`,
      );
      const block = html.slice(open, close);
      const source = /<source\s+type="image\/avif"\s+srcset="([^"]*)"/.exec(block);
      assert.ok(
        source !== null,
        `${file} has an image ${src} in a <picture> with no AVIF source: add <source type="image/avif" srcset="/img/....avif" />`,
      );
      const avif = source[1];
      assert.ok(
        avif.startsWith("/img/") && avif.endsWith(".avif"),
        `${file} has an image ${src} with AVIF source ${avif}: point it at a .avif under /img/`,
      );
      assert.ok(
        existsSync(new URL(`../public${avif}`, import.meta.url)),
        `${file} has an image ${src} with AVIF source ${avif}, which is missing: generate public${avif} with avifenc`,
      );
    }
  }
});

test("every root page footer links to the PVM analysis and grouping level pages", () => {
  for (const page of ROOT_PAGES) {
    const html = readPage(page.file);
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html);
    assert.ok(footer, `${page.file} has no <footer>: add the shared footer links`);
    const body = footer[1];
    const guide = body.indexOf('<a href="/guide.html">');
    assert.ok(
      guide !== -1,
      `${page.file} footer has no guide link: keep the shared footer links`,
    );
    const analysis = body.indexOf('<a href="/price-volume-mix-analysis.html">');
    assert.ok(
      analysis !== -1,
      `${page.file} footer has no PVM analysis link: add <a href="/price-volume-mix-analysis.html">PVM analysis</a> after the guide link`,
    );
    const grouping = body.indexOf('<a href="/grouping-level.html">');
    assert.ok(
      grouping !== -1,
      `${page.file} footer has no grouping level link: add <a href="/grouping-level.html">Grouping level</a> after the PVM analysis link`,
    );
    assert.ok(
      analysis > guide,
      `${page.file} footer puts the PVM analysis link before the guide link: move it after <a href="/guide.html">Guide</a>`,
    );
    assert.ok(
      grouping > guide,
      `${page.file} footer puts the grouping level link before the guide link: move it after <a href="/guide.html">Guide</a>`,
    );
  }
});

test("the home page carries exactly one WebSite block", () => {
  const html = readPage("index.html");
  const blocks = [
    ...html.matchAll(
      /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ];
  assert.equal(
    blocks.length,
    1,
    `index.html has ${blocks.length} application/ld+json blocks: add exactly one WebSite block after the twitter:card line`,
  );
  let site: Record<string, unknown> = {};
  try {
    site = JSON.parse(blocks[0][1]) as Record<string, unknown>;
  } catch {
    assert.fail(
      "index.html has an application/ld+json block that is not valid JSON: write it as one valid object",
    );
  }
  assert.equal(
    site["@type"],
    "WebSite",
    `index.html structured data has @type ${String(site["@type"])}: use "WebSite"`,
  );
  assert.equal(
    site.name,
    "PVM Bridge",
    `index.html structured data has name ${String(site.name)}: use "PVM Bridge"`,
  );
  assert.equal(
    site.url,
    `${ORIGIN}/`,
    `index.html structured data has url ${String(site.url)}: use "${ORIGIN}/"`,
  );
});

test("the home page carries fewer than 400 visible words", () => {
  const words = visibleWordsOf(readPage("index.html"));
  assert.ok(
    words.length < 400,
    `index.html has ${words.length} visible words: cut the page to fewer than 400 and keep the short landing copy`,
  );
});

test("the home page has exactly one h1 and it names price-volume-mix", () => {
  const headings = [
    ...readPage("index.html").matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi),
  ];
  assert.equal(
    headings.length,
    1,
    `index.html has ${headings.length} <h1> elements: give the page exactly one heading`,
  );
  const text = collapseSpaces(headings[0][1]).toLowerCase();
  assert.ok(
    text.includes("price-volume-mix"),
    `index.html h1 is "${collapseSpaces(headings[0][1])}": write a heading that names price-volume-mix`,
  );
});

const HOME_LINKS = [
  "/app/",
  "/guide.html",
  "/method.html",
  "/price-volume-mix-analysis.html",
  "/grouping-level.html",
  "/privacy.html",
  "/terms.html",
];

test("the home page links to the tool, the guide and every reference page", () => {
  const hrefs = new Set(
    [...readPage("index.html").matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)].map(
      (match) => match[1],
    ),
  );
  for (const link of HOME_LINKS) {
    assert.ok(
      hrefs.has(link),
      `index.html has no <a href="${link}">: add the link so the page still points at every page it describes`,
    );
  }
});

const GITHUB = "https://github.com/creedants/bridgekit";

test("the home page loads nothing from another host and runs no script", () => {
  const html = readPage("index.html");
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  assert.equal(
    scripts.length,
    1,
    `index.html has ${scripts.length} <script> elements: keep only the one application/ld+json block`,
  );
  assert.ok(
    /type="application\/ld\+json"/.test(scripts[0]),
    "index.html has a script that is not the application/ld+json block: the home page runs no script",
  );

  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
    const attributes = attributesOf(tag[0]);
    for (const [name, value] of attributes) {
      if (!/^(https?:)?\/\//.test(value)) continue;
      if (
        name === "href" &&
        tag[0].startsWith("<link") &&
        attributes.get("rel") === "canonical"
      ) {
        continue;
      }
      if (
        name === "content" &&
        tag[0].startsWith("<meta") &&
        (attributes.get("property") ?? "").startsWith("og:")
      ) {
        continue;
      }
      if (name === "href" && tag[0].startsWith("<a") && value === GITHUB) continue;
      assert.fail(
        `index.html has ${name}="${value}": load nothing from another host, apart from the canonical address, the og: values and the GitHub link`,
      );
    }
  }
});

test("the home page keeps its own stylesheet", () => {
  const html = readPage("index.html");
  assert.ok(
    /<link\b[^>]*\shref="\/src\/site\/home\.css"/.test(html),
    "index.html does not link /src/site/home.css: keep the home page stylesheet separate from src/site/site.css",
  );
  for (const page of ROOT_PAGES) {
    if (page.file === "index.html") continue;
    assert.ok(
      !readPage(page.file).includes("/src/site/home.css"),
      `${page.file} links /src/site/home.css: only the home page uses it`,
    );
  }
  const path = new URL("../src/site/home.css", import.meta.url);
  assert.ok(
    existsSync(path),
    "src/site/home.css is missing: add the home page stylesheet it links",
  );
  assert.equal(
    /@import/.test(readFileSync(path, "utf8")),
    false,
    "src/site/home.css imports another stylesheet: keep the home page stylesheet self-contained",
  );
});

test("the home page keeps the counts sentence for the counts build", () => {
  const counts =
    '<!-- feature:!counts -->No analytics.<!-- /feature:!counts --><!-- feature:counts -->No tracking scripts.<!-- /feature:counts -->';
  assert.ok(
    readPage("index.html").includes(counts),
    "index.html has no counts sentence: keep the two counts feature blocks side by side in the privacy paragraph",
  );
});

test("the description lengths and the terms description follow the contract", () => {
  const grouping = descriptionsOf(headOf("grouping-level.html", readPage("grouping-level.html")))[0];
  assert.ok(
    grouping.length <= 160,
    `grouping-level.html description is ${grouping.length} characters: cut it to 160 or fewer`,
  );
  const terms = descriptionsOf(headOf("terms.html", readPage("terms.html")))[0];
  assert.equal(
    terms,
    TERMS_DESCRIPTION,
    `terms.html description is "${terms}": use "${TERMS_DESCRIPTION}"`,
  );
});

test("the app page ships one h1 and the description inside the root element", () => {
  const html = readPage("app/index.html");
  const headings = [...html.matchAll(/<h1>([\s\S]*?)<\/h1>/g)];
  assert.equal(
    headings.length,
    1,
    `app/index.html has ${headings.length} <h1> elements: give it exactly one`,
  );
  assert.equal(
    headings[0][1].trim(),
    "Price-volume-mix bridge tool",
    `app/index.html h1 is "${headings[0][1].trim()}": use "Price-volume-mix bridge tool"`,
  );
  const root = html.indexOf('<div id="root">');
  assert.ok(
    root !== -1,
    `app/index.html has no <div id="root">: keep the mount point the app replaces`,
  );
  const rootEnd = html.indexOf("</div>", root);
  assert.ok(
    rootEnd !== -1,
    `app/index.html has no closing </div> after <div id="root">: close the mount point`,
  );
  const headingIndex = headings[0].index ?? -1;
  assert.ok(
    headingIndex > root && headingIndex < rootEnd,
    `app/index.html puts its h1 outside <div id="root">: move the fallback inside the mount point`,
  );
  const paragraph = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].find(
    (match) => match[1].trim() === APP_DESCRIPTION,
  );
  assert.ok(
    paragraph !== undefined,
    `app/index.html has no <p> holding the tool description: add <p>${APP_DESCRIPTION}</p> inside <div id="root">`,
  );
  const paragraphIndex = paragraph.index ?? -1;
  assert.ok(
    paragraphIndex > root && paragraphIndex < rootEnd,
    `app/index.html puts the description paragraph outside <div id="root">: move it inside the mount point`,
  );
});

test("the app mount point contains the fallback margin so the page does not shift", () => {
  const head = headOf("app/index.html", readPage("app/index.html"));
  const rules = [...head.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (match) => /#root\s*\{([^}]*)\}/.exec(match[1]),
  );
  const root = rules.find((rule) => rule !== null);
  assert.ok(
    root,
    "app/index.html <head> has no #root rule: add <style>#root { display: flow-root; }</style> after the favicon link so the fallback margin cannot collapse out of the mount point",
  );
  const declarations = root[1];
  assert.ok(
    /display:\s*flow-root/.test(declarations),
    `app/index.html #root rule says "${declarations.trim()}" without display: flow-root: set it so the fallback margin cannot collapse out of the mount point`,
  );
});

test("the Pro plan card lists only the planned features", () => {
  const features = plannedFeaturesOf(readPage("index.html"), "index.html");
  assert.deepEqual(
    features,
    PRO_FEATURES,
    `the Pro plan card lists ${features.join(", ")}: it should list exactly ${PRO_FEATURES.join(", ")}`,
  );
});

const FREE_PLAN_CARD = `<div class="plan">
  <span class="tag">Available now</span>
  <h3>Free</h3>
  <ul>
    <li>The full bridge, any number of attributes</li>
    <li>Excel and CSV export</li>
  </ul>
  <a class="button" href="https://example.com/">Open the tool</a>
</div>`;

const PRO_ITEMS = PRO_FEATURES.map((feature) => `<li>${feature}</li>`);

function planCardMarkup({
  open = '<div class="plan">',
  tagClass = "tag muted",
  listOpen = "<ul>",
  items = PRO_ITEMS,
}: {
  open?: string;
  tagClass?: string;
  listOpen?: string;
  items?: string[];
} = {}): string {
  return `${open}
  <span class="${tagClass}">Planned</span>
  <h3>Pro</h3>
  <div class="price">$19</div>
  ${listOpen}
  ${items.join("\n  ")}
  </ul>
  <a class="button secondary" href="https://example.com/">Follow on GitHub</a>
</div>`;
}

const PLAN_PROBES: Array<{
  name: string;
  card: string;
  expected: string[];
  rejectsProFeatures?: boolean;
}> = [
  {
    name: "extra space in the Pro card opening tag",
    card: planCardMarkup({ open: '<div  class="plan">' }),
    expected: PRO_FEATURES,
  },
  {
    name: "an attribute before class on the Pro card",
    card: planCardMarkup({ open: '<div data-plan="pro" class="plan">' }),
    expected: PRO_FEATURES,
  },
  {
    name: "<ul > in the Pro card",
    card: planCardMarkup({ listOpen: "<ul >" }),
    expected: PRO_FEATURES,
  },
  {
    name: "the Planned tag class tokens reversed",
    card: planCardMarkup({ tagClass: "muted tag" }),
    expected: PRO_FEATURES,
  },
  {
    name: "a line break inside an item's text",
    card: planCardMarkup({
      items: ["<li>Saved workspaces\n        across devices</li>", ...PRO_ITEMS.slice(1)],
    }),
    expected: PRO_FEATURES,
  },
  {
    name: "an attributed fifth item",
    card: planCardMarkup({
      items: [...PRO_ITEMS, '<li class="feature">Unexpected feature</li>'],
    }),
    expected: [...PRO_FEATURES, "Unexpected feature"],
    rejectsProFeatures: true,
  },
];

test("the Pro plan card extraction tolerates formatting and reads every list item", () => {
  for (const probe of PLAN_PROBES) {
    const html = `<div class="plans">${FREE_PLAN_CARD}${probe.card}</div>`;
    const features = plannedFeaturesOf(html, probe.name);
    assert.deepEqual(
      features,
      probe.expected,
      `${probe.name} extracted ${features.join(", ")}: it should extract ${probe.expected.join(", ")}`,
    );
    if (probe.rejectsProFeatures) {
      assert.throws(
        () => assert.deepEqual(features, PRO_FEATURES),
        `${probe.name} extracted ${features.join(", ")}, which must not match ${PRO_FEATURES.join(", ")}`,
      );
    }
  }
});

test("the styled images scale their width and let the height follow", () => {
  const css = readFileSync(new URL("../src/site/site.css", import.meta.url), "utf8");
  const gallery = /\.gallery img\s*\{([^}]*)\}/.exec(css);
  assert.ok(
    gallery,
    "src/site/site.css has no .gallery img rule: keep the gallery image width and add height: auto",
  );
  assert.ok(
    /width:\s*100%/.test(gallery[1]),
    "src/site/site.css .gallery img does not scale its width: keep width: 100%",
  );
  assert.ok(
    /height:\s*auto/.test(gallery[1]),
    "src/site/site.css .gallery img has no height: auto: add it so the picture keeps the PNG aspect ratio",
  );

  const guide = readPage("guide.html");
  for (const image of guide.matchAll(/<img\b[^>]*>/g)) {
    const attributes = attributesOf(image[0]);
    const src = attributes.get("src") ?? "";
    const style = attributes.get("style") ?? "";
    assert.ok(
      /width:\s*100%/.test(style),
      `guide.html image ${src} has no width: 100% in its inline style: keep the width it had`,
    );
    assert.ok(
      /height:\s*auto/.test(style),
      `guide.html image ${src} has no height: auto in its inline style: append it so the picture keeps the PNG aspect ratio`,
    );
  }
});
