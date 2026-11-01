import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODULE = fileURLToPath(new URL("../scripts/indexnow.mjs", import.meta.url));
const KEY = "0123456789abcdef0123456789abcdef";
const SITEMAP = (urls: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url><loc>${url}</loc></url>\n`)
    .join("")}</urlset>\n`;

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };
type RunOptions = {
  args?: string[];
  root?: URL;
  fetch?: (url: string, init: FetchCall["init"]) => Promise<Response>;
  print?: (line: string) => void;
  printError?: (line: string) => void;
};

const { run } = (await import(MODULE)) as { run: (options: RunOptions) => Promise<number> };

function committedKey(): string {
  const dir = new URL("../public/", import.meta.url);
  const keys = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => ({ name, stem: name.slice(0, -4) }))
    .filter(({ name, stem }) => /^[a-zA-Z0-9-]{8,128}$/.test(stem) && readFileSync(new URL(name, dir), "utf8").trim() === stem);
  assert.equal(
    keys.length,
    1,
    `public/ has ${keys.length} IndexNow key files: add one 8 to 128 character .txt whose content is its own name`,
  );
  return keys[0].stem;
}

function sitemapUrls(): string[] {
  const xml = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
}

type Harness = { args?: string[]; status?: number; failure?: Error };

async function runWith(root: URL | undefined, harness: Harness) {
  const calls: FetchCall[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  const code = await run({
    root,
    args: harness.args ?? [],
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (harness.failure !== undefined) throw harness.failure;
      return new Response(null, { status: harness.status ?? 200 });
    },
    print: (line) => out.push(line),
    printError: (line) => errors.push(line),
  });
  return { code, out, errors, calls };
}

function runHere(harness: Harness = {}) {
  return runWith(undefined, harness);
}

async function runOn(files: Record<string, string>, harness: Harness = {}) {
  const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
  try {
    mkdirSync(join(dir, "public"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "public", name), content);
    return await runWith(pathToFileURL(`${dir}/`), harness);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function keyFile(): Record<string, string> {
  return { [`${KEY}.txt`]: `${KEY}\n` };
}

test("the committed sitemap and key produce the request IndexNow expects", async () => {
  const key = committedKey();
  const urls = sitemapUrls();
  const result = await runHere();
  assert.equal(result.calls.length, 1, `the run sent ${result.calls.length} requests: it sends one POST carrying every URL`);
  const [call] = result.calls;
  assert.equal(call.url, "https://api.indexnow.org/indexnow", "the request does not go to the IndexNow endpoint");
  assert.equal(call.init.method, "POST", "the request is not a POST: IndexNow reads the URLs from its body");
  assert.equal(
    call.init.headers?.["Content-Type"],
    "application/json; charset=utf-8",
    "the request does not declare a JSON body with its charset",
  );
  assert.deepEqual(
    JSON.parse(call.init.body ?? "null"),
    { host: "pvmbridge.com", key, keyLocation: `https://pvmbridge.com/${key}.txt`, urlList: urls },
    "the body does not carry the host, the committed key, its key location and the sitemap URLs in sitemap order",
  );
});

test("--dry-run prints the endpoint and the exact body without sending", async () => {
  const dry = await runHere({ args: ["--dry-run"] });
  const real = await runHere();
  assert.equal(dry.code, 0, `the dry run exited ${dry.code}: a dry run succeeds without contacting IndexNow`);
  assert.equal(dry.calls.length, 0, "the dry run sent a request: --dry-run must contact nothing");
  assert.deepEqual(
    dry.out,
    ["POST https://api.indexnow.org/indexnow", real.calls[0].init.body],
    "the dry run does not print the endpoint line followed by the exact body a real send carries",
  );
});

test("a 200 is accepted", async () => {
  const result = await runHere({ status: 200 });
  assert.equal(result.code, 0, `a 200 exited ${result.code}: IndexNow accepted the submission`);
  assert.deepEqual(
    result.out,
    [`IndexNow accepted ${sitemapUrls().length} URLs (200).`],
    "a 200 does not report the accepted URL count and status",
  );
});

test("a 202 is accepted", async () => {
  const result = await runHere({ status: 202 });
  assert.equal(result.code, 0, `a 202 exited ${result.code}: IndexNow accepted the submission`);
  assert.deepEqual(
    result.out,
    [`IndexNow accepted ${sitemapUrls().length} URLs (202).`],
    "a 202 does not report the accepted URL count and status",
  );
});

test("a 403 names an invalid key", async () => {
  const result = await runHere({ status: 403 });
  assert.equal(result.code, 1, `a 403 exited ${result.code}: a refused submission fails the deploy step`);
  assert.deepEqual(result.errors, ["IndexNow failed (403): key not valid."], "a 403 does not explain that the key is not valid");
});

test("a 422 names the host or key mismatch", async () => {
  const result = await runHere({ status: 422 });
  assert.equal(result.code, 1, `a 422 exited ${result.code}: a refused submission fails the deploy step`);
  assert.deepEqual(
    result.errors,
    ["IndexNow failed (422): URLs do not belong to the host or key mismatch."],
    "a 422 does not explain that the URLs do not belong to the host or the key does not match",
  );
});

test("a 429 names the rate limit", async () => {
  const result = await runHere({ status: 429 });
  assert.equal(result.code, 1, `a 429 exited ${result.code}: a refused submission fails the deploy step`);
  assert.deepEqual(result.errors, ["IndexNow failed (429): too many requests."], "a 429 does not explain that there were too many requests");
});

test("a thrown fetch reports no response without throwing", async () => {
  const result = await runHere({ failure: new Error("boom") });
  assert.equal(result.code, 1, `a thrown fetch exited ${result.code}: no response fails the deploy step`);
  assert.deepEqual(result.errors, ["IndexNow failed (no response): boom."], "a thrown fetch does not report its first message line");
});

test("no key file refuses and names the .txt files it saw", async () => {
  const result = await runOn({ "robots.txt": "User-agent: *\n" });
  assert.equal(result.code, 1, `a tree with no key file exited ${result.code}: a run with no key cannot report URLs`);
  assert.deepEqual(
    result.errors,
    [
      "indexnow: no key file in public/: add one <key>.txt whose content is <key> (8 to 128 characters of a-z A-Z 0-9 -); .txt files seen: robots.txt",
    ],
    "the refusal does not say how to add a key or which .txt files it saw",
  );
  assert.equal(result.calls.length, 0, "a refused run sent a request");
});

test("two key files refuse and name both in sorted order", async () => {
  const result = await runOn({ "a2345678.txt": "a2345678\n", "b2345678.txt": "b2345678\n" });
  assert.equal(result.code, 1, `a tree with two key files exited ${result.code}: IndexNow takes one key`);
  assert.deepEqual(
    result.errors,
    ["indexnow: 2 key files in public/: a2345678.txt, b2345678.txt; keep exactly one"],
    "the refusal does not name both key files in sorted order",
  );
  assert.equal(result.calls.length, 0, "a refused run sent a request");
});

test("a .txt whose content differs from its name is not a key file", async () => {
  const result = await runOn({ "abcdefgh.txt": "87654321\n" });
  assert.equal(result.code, 1, `a mismatched .txt exited ${result.code}: the key file's content is its own name`);
  assert.deepEqual(
    result.errors,
    [
      "indexnow: no key file in public/: add one <key>.txt whose content is <key> (8 to 128 characters of a-z A-Z 0-9 -); .txt files seen: abcdefgh.txt",
    ],
    "the refusal does not treat a .txt whose content differs from its name as an ordinary .txt file",
  );
  assert.equal(result.calls.length, 0, "a refused run sent a request");
});

test("a sitemap URL outside the host refuses, look-alikes included", async () => {
  for (const foreign of ["https://example.com/", "https://pvmbridge.com.evil/"]) {
    const result = await runOn({ ...keyFile(), "sitemap.xml": SITEMAP([foreign]) });
    assert.equal(result.code, 1, `a sitemap listing ${foreign} exited ${result.code}: IndexNow only takes URLs under the host`);
    assert.deepEqual(
      result.errors,
      [`indexnow: public/sitemap.xml lists ${foreign}, which is not under https://pvmbridge.com/: run node scripts/sitemap.mjs`],
      `the refusal does not name ${foreign} and how to regenerate the sitemap`,
    );
    assert.equal(result.calls.length, 0, "a refused run sent a request");
  }
});

test("a sitemap with no <loc> refuses", async () => {
  const result = await runOn({ ...keyFile(), "sitemap.xml": SITEMAP([]) });
  assert.equal(result.code, 1, `an empty sitemap exited ${result.code}: there is nothing to report`);
  assert.deepEqual(
    result.errors,
    ["indexnow: public/sitemap.xml has no <loc> URLs: run node scripts/sitemap.mjs"],
    "the refusal does not say the sitemap has no <loc> URLs or how to regenerate it",
  );
  assert.equal(result.calls.length, 0, "a refused run sent a request");
});

test("the CLI prints the same two lines on a dry run", () => {
  const result = spawnSync(process.execPath, ["scripts/indexnow.mjs", "--dry-run"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `node scripts/indexnow.mjs --dry-run exited ${result.status}: ${result.stderr.trim() || "no error output"}`,
  );
  const key = committedKey();
  const body = JSON.stringify({
    host: "pvmbridge.com",
    key,
    keyLocation: `https://pvmbridge.com/${key}.txt`,
    urlList: sitemapUrls(),
  });
  assert.equal(
    result.stdout,
    `POST https://api.indexnow.org/indexnow\n${body}\n`,
    "the CLI does not print the endpoint line followed by the request body",
  );
});
