// Tells IndexNow that the site's URLs changed. The coordinator runs it from the
// deploy machine after a deploy. Nothing else calls it, so no page, app or
// Worker ever contacts another host.
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOST = "pvmbridge.com";
const ORIGIN = `https://${HOST}/`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const KEY_NAME = /^[a-zA-Z0-9-]{8,128}$/;
const REASONS = new Map([
  [400, "bad request"],
  [403, "key not valid"],
  [422, "URLs do not belong to the host or key mismatch"],
  [429, "too many requests"],
]);
const DEFAULT_ROOT = new URL("..", import.meta.url);

function keyIn(root) {
  const names = readdirSync(new URL("public/", root))
    .filter((name) => name.endsWith(".txt"))
    .sort();
  const keys = names.filter((name) => {
    const stem = name.slice(0, -4);
    return KEY_NAME.test(stem) && readFileSync(new URL(`public/${name}`, root), "utf8").trim() === stem;
  });
  if (keys.length === 1) return { key: keys[0].slice(0, -4) };
  if (keys.length === 0) {
    return {
      error: `no key file in public/: add one <key>.txt whose content is <key> (8 to 128 characters of a-z A-Z 0-9 -); .txt files seen: ${names.length === 0 ? "none" : names.join(", ")}`,
    };
  }
  return { error: `${keys.length} key files in public/: ${keys.join(", ")}; keep exactly one` };
}

function urlsIn(root) {
  const xml = readFileSync(new URL("public/sitemap.xml", root), "utf8");
  const urls = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
  if (urls.length === 0) {
    return { error: "public/sitemap.xml has no <loc> URLs: run node scripts/sitemap.mjs" };
  }
  const foreign = urls.find((url) => !url.startsWith(ORIGIN));
  if (foreign !== undefined) {
    return { error: `public/sitemap.xml lists ${foreign}, which is not under ${ORIGIN}: run node scripts/sitemap.mjs` };
  }
  return { urls };
}

/**
 * The whole job. Never throws. Prints through the injected writers.
 * @param {{ args?: string[], root?: URL, fetch?: (url: string, init: object) => Promise<Response>,
 *           print?: (line: string) => void, printError?: (line: string) => void }} [options]
 * @returns {Promise<0 | 1>} the process exit code
 */
export async function run(options = {}) {
  const args = options.args ?? [];
  const root = options.root ?? DEFAULT_ROOT;
  const send = options.fetch ?? globalThis.fetch;
  const print = options.print ?? console.log;
  const printError = options.printError ?? console.error;

  const fail = (message) => {
    printError(message);
    return 1;
  };

  try {
    const unknown = args.find((arg) => arg !== "--dry-run");
    if (unknown !== undefined) return fail(`indexnow: unknown argument ${unknown}: the only option is --dry-run`);

    const found = keyIn(root);
    if (found.error !== undefined) return fail(`indexnow: ${found.error}`);
    const listed = urlsIn(root);
    if (listed.error !== undefined) return fail(`indexnow: ${listed.error}`);

    const key = found.key;
    const urls = listed.urls;
    // One string, so a dry run shows exactly the bytes a real send carries.
    const body = JSON.stringify({ host: HOST, key, keyLocation: `${ORIGIN}${key}.txt`, urlList: urls });

    if (args.includes("--dry-run")) {
      print(`POST ${ENDPOINT}`);
      print(body);
      return 0;
    }

    let response;
    try {
      response = await send(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
      });
    } catch (error) {
      const message = String(error?.message ?? error).split("\n")[0];
      return fail(`IndexNow failed (no response): ${message}.`);
    }

    if (response.status === 200 || response.status === 202) {
      print(`IndexNow accepted ${urls.length} URLs (${response.status}).`);
      return 0;
    }
    const reason = REASONS.get(response.status) ?? "unexpected response";
    return fail(`IndexNow failed (${response.status}): ${reason}.`);
  } catch (error) {
    return fail(`indexnow: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({ args: process.argv.slice(2) });
}
