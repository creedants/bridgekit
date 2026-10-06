import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "../server/cloudflare.ts";
import type { Env } from "../server/env.ts";
import app from "../server/worker.ts";
import { testDatabase } from "./support/d1.ts";

const GUIDE = "<!doctype html><title>Guide</title>";
const METHOD = "<!doctype html><title>Method</title>";
const PRIVACY = "<!doctype html><title>Privacy</title>";
const ARTICLE = "<!doctype html><title>Price volume mix</title>";

function redirect(location: string): Response {
  return new Response("redirect", { status: 307, headers: { location, "content-type": "text/html; charset=utf-8" } });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

type AssetCall = { method: string; pathname: string; search: string; ifNoneMatch: string | null; body: string };
type AssetPage = Response | ((request: Request) => Response);

function bindings(pages: Record<string, AssetPage>): { env: Env; db: Env["DB"]; calls: AssetCall[] } {
  const db = testDatabase();
  const calls: AssetCall[] = [];
  const assets: Fetcher = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        ifNoneMatch: request.headers.get("if-none-match"),
        body: await request.clone().text(),
      });
      const page = pages[url.pathname];
      if (!page) return new Response("missing", { status: 500 });
      return typeof page === "function" ? page(request) : page.clone();
    },
  };
  return {
    db,
    calls,
    env: {
      ASSETS: assets,
      DB: db,
      BETTER_AUTH_URL: "http://127.0.0.1:8790",
      BETTER_AUTH_SECRET: "test-secret",
    },
  };
}

async function open(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "Mozilla/5.0");
  if (!headers.has("sec-fetch-dest")) headers.set("sec-fetch-dest", "document");
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(`http://127.0.0.1:8790${path}`, { ...init, headers }), env, {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}

async function views(db: Env["DB"]): Promise<{ path: string; referrer: string; views: number }[]> {
  const rows = await db.prepare("SELECT path, referrer, views FROM page_views ORDER BY path").all<{ path: string; referrer: string; views: number }>();
  return rows.results;
}

test("an html address returns that page and counts the request once", async () => {
  const { env, db, calls } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
    "/method.html": redirect("/method"),
    "/method": html(METHOD),
    "/privacy.html": redirect("/privacy"),
    "/privacy": html(PRIVACY),
    "/price-volume-mix-analysis.html": redirect("/price-volume-mix-analysis"),
    "/price-volume-mix-analysis": html(ARTICLE),
  });
  const guide = await open("/guide.html", env);
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get("location"), null);
  assert.equal(await guide.text(), GUIDE);
  const method = await open("/method.html", env);
  const privacy = await open("/privacy.html", env);
  const article = await open("/price-volume-mix-analysis.html", env);
  assert.equal(method.status, 200);
  assert.equal(await method.text(), METHOD);
  assert.equal(privacy.status, 200);
  assert.equal(await privacy.text(), PRIVACY);
  assert.equal(article.status, 200);
  assert.equal(await article.text(), ARTICLE);
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ["/guide", "/method", "/privacy", "/price-volume-mix-analysis"],
  );
  assert.deepEqual(await views(db), [
    { path: "/guide.html", referrer: "", views: 1 },
    { path: "/method.html", referrer: "", views: 1 },
    { path: "/price-volume-mix-analysis.html", referrer: "", views: 1 },
    { path: "/privacy.html", referrer: "", views: 1 },
  ]);
});

test("the extensionless address counts its own path and not the html address", async () => {
  const { env, db } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
  });
  const response = await open("/guide", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), GUIDE);
  assert.deepEqual(await views(db), [{ path: "/guide", referrer: "", views: 1 }]);
});

test("two requests for the same html address count two views of that address", async () => {
  const { env, db } = bindings({
    "/method.html": redirect("/method"),
    "/method": html(METHOD),
  });
  assert.equal((await open("/method.html", env)).status, 200);
  assert.equal((await open("/method.html", env)).status, 200);
  assert.deepEqual(await views(db), [{ path: "/method.html", referrer: "", views: 2 }]);
});

test("an html address is read from the extensionless file even when the html name itself is a page", async () => {
  const { env, db, calls } = bindings({
    "/privacy.html": html("<!doctype html><title>Wrong</title>"),
    "/privacy": html(PRIVACY),
  });
  const response = await open("/privacy.html", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PRIVACY);
  assert.deepEqual(calls.map((call) => call.pathname), ["/privacy"]);
  assert.deepEqual(await views(db), [{ path: "/privacy.html", referrer: "", views: 1 }]);
});

test("index.html redirects stay redirects", async () => {
  const { env, db, calls } = bindings({
    "/index.html": redirect("/"),
    "/": html(GUIDE),
    "/app/index.html": redirect("/app/"),
    "/app/": html(METHOD),
    "/pay/index.html": redirect("/pay/"),
    "/pay/": html(ARTICLE),
  });
  const home = await open("/index.html", env);
  const appPage = await open("/app/index.html", env);
  const pay = await open("/pay/index.html", env);
  assert.equal(home.status, 307);
  assert.equal(home.headers.get("location"), "/");
  assert.equal(appPage.status, 307);
  assert.equal(appPage.headers.get("location"), "/app/");
  assert.equal(pay.status, 307);
  assert.equal(pay.headers.get("location"), "/pay/");
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ["/index.html", "/app/index.html", "/pay/index.html"],
  );
  assert.deepEqual(await views(db), []);
});

test("HEAD does not count", async () => {
  const { env, db, calls } = bindings({
    "/guide.html": redirect("/guide"),
    "/guide": html(GUIDE),
  });
  const response = await open("/guide.html", env, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, [{ method: "HEAD", pathname: "/guide", search: "", ifNoneMatch: null, body: "" }]);
  assert.deepEqual(await views(db), []);
});

test("a conditional 304 does not count", async () => {
  const { env, db, calls } = bindings({
    "/method.html": redirect("/method"),
    "/method": (request) => {
      assert.equal(request.headers.get("if-none-match"), '"page"');
      return new Response(null, { status: 304, headers: { etag: '"page"' } });
    },
  });
  const response = await open("/method.html", env, { headers: { "if-none-match": '"page"' } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"page"');
  assert.deepEqual(calls.map((call) => ({ method: call.method, pathname: call.pathname, ifNoneMatch: call.ifNoneMatch })), [
    { method: "GET", pathname: "/method", ifNoneMatch: '"page"' },
  ]);
  assert.deepEqual(await views(db), []);
});

test("a query string is kept on the asset request and the count uses the html address", async () => {
  const { env, db, calls } = bindings({
    "/privacy.html": redirect("/privacy"),
    "/privacy": html(PRIVACY),
  });
  const response = await open("/privacy.html?a=1&a=2&encoded=%2F", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PRIVACY);
  assert.deepEqual(calls, [
    { method: "GET", pathname: "/privacy", search: "?a=1&a=2&encoded=%2F", ifNoneMatch: null, body: "" },
  ]);
  assert.deepEqual(await views(db), [{ path: "/privacy.html", referrer: "", views: 1 }]);
});

test("POST and PUT to an extensionless page are passed through unchanged", async () => {
  const denied = new Response(null, {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "content-security-policy": "default-src 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "permissions-policy": "camera=()",
    },
  });
  const { env, db, calls } = bindings({
    "/guide": (request) => {
      assert.equal(request.headers.get("x-probe"), "1");
      return denied.clone();
    },
  });
  for (const method of ["POST", "PUT"]) {
    const response = await open("/guide?x=1", env, { method, body: "payload", headers: { "x-probe": "1" } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("permissions-policy"), "camera=()");
  }
  assert.deepEqual(calls, [
    { method: "POST", pathname: "/guide", search: "?x=1", ifNoneMatch: null, body: "payload" },
    { method: "PUT", pathname: "/guide", search: "?x=1", ifNoneMatch: null, body: "payload" },
  ]);
  assert.deepEqual(await views(db), []);
});

test("a redirect for a path that is not an html page is returned and not counted", async () => {
  const { env, db } = bindings({
    "/old": redirect("/new"),
    "/new": html(GUIDE),
  });
  const response = await open("/old", env);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/new");
  assert.deepEqual(await views(db), []);
});
