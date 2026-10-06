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

function bindings(pages: Record<string, Response>): { env: Env; db: Env["DB"] } {
  const db = testDatabase();
  const assets: Fetcher = {
    async fetch(input) {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      return pages[path] ? pages[path].clone() : new Response("missing", { status: 500 });
    },
  };
  return {
    db,
    env: {
      ASSETS: assets,
      DB: db,
      BETTER_AUTH_URL: "http://127.0.0.1:8790",
      BETTER_AUTH_SECRET: "test-secret",
    },
  };
}

async function open(path: string, env: Env): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8790${path}`, {
      headers: { "user-agent": "Mozilla/5.0", "sec-fetch-dest": "document" },
    }),
    env,
    {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
  );
  await Promise.all(pending);
  return response;
}

async function views(db: Env["DB"]): Promise<{ path: string; referrer: string; views: number }[]> {
  const rows = await db.prepare("SELECT path, referrer, views FROM page_views ORDER BY path").all<{ path: string; referrer: string; views: number }>();
  return rows.results;
}

test("an html address returns that page and counts the request once", async () => {
  const { env, db } = bindings({
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

test("an html file served without a redirect is counted once", async () => {
  const { env, db } = bindings({
    "/privacy.html": html(PRIVACY),
  });
  const response = await open("/privacy.html", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PRIVACY);
  assert.deepEqual(await views(db), [{ path: "/privacy.html", referrer: "", views: 1 }]);
});

test("a redirect to another site is returned and not counted", async () => {
  const { env, db } = bindings({
    "/guide.html": redirect("https://evil.example/guide"),
  });
  const response = await open("/guide.html", env);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://evil.example/guide");
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
