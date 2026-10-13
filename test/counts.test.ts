import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPagePath, countPageView, pageView, referrerLabel } from "../server/counts.ts";
import { testDatabase } from "./support/d1.ts";

const articles = new Set([
  "/guide.html",
  "/method.html",
  "/privacy.html",
  "/price-volume-mix-analysis.html",
  "/grouping-level.html",
]);

const html = () => new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } });

test("a known page has one stored path", () => {
  const pages = ["guide", "method", "privacy", "price-volume-mix-analysis", "grouping-level"];
  for (const page of pages) {
    assert.equal(canonicalPagePath(`/${page}`, articles), `/${page}`);
    assert.equal(canonicalPagePath(`/${page}.html`, articles), `/${page}`);
    assert.equal(canonicalPagePath(`/${page}.html?x=1`, articles), `/${page}`);
    assert.equal(canonicalPagePath(`https://bk.example/${page}.html?x=1#y`, articles), `/${page}`);
  }
  assert.equal(canonicalPagePath("/", articles), "/");
  assert.equal(canonicalPagePath("/?x=1", articles), "/");
  assert.equal(canonicalPagePath("/app/", articles), "/app/");
  assert.equal(canonicalPagePath("/app/?sample=3", articles), "/app/");
  assert.equal(canonicalPagePath("https://bk.example/app/?sample=3", articles), "/app/");
});

test("a path that is not a known page is not a stored path", () => {
  for (const address of ["/guide/", "/Guide", "/GUIDE.HTML", "/guide.html/", "/app", "/index.html", "/app/index.html", "/pay/", "/pay/index.html", "/not-a-page", "/favicon.ico"]) {
    assert.equal(canonicalPagePath(address, articles), null);
  }
  assert.equal(canonicalPagePath("https://bk.example/pay/?plan=pro", articles), null);
});

test("a referrer is the foreign host, or nothing", () => {
  const page = "https://bk.example/guide";
  assert.equal(referrerLabel(null, page), "");
  assert.equal(referrerLabel("", page), "");
  assert.equal(referrerLabel("not a url", page), "");
  assert.equal(referrerLabel("/relative", page), "");
  assert.equal(referrerLabel("https://www.linkedin.com/feed/x", page), "www.linkedin.com");
  assert.equal(referrerLabel("https://münchen.example/a", page), "xn--mnchen-3ya.example");
  assert.equal(referrerLabel("https://xn--mnchen-3ya.example/a", page), "xn--mnchen-3ya.example");
  assert.equal(referrerLabel("http://203.0.113.10:8080/a", page), "203.0.113.10");
  assert.equal(referrerLabel("http://192.0.2.1/a", page), "192.0.2.1");
  assert.equal(referrerLabel("http://[2001:DB8::1]:8443/a", page), "2001:db8::1");
  assert.equal(referrerLabel("https://user:pass@News.Example:8443/a/b?q=1", page), "news.example");
  assert.equal(referrerLabel("https://user:pass@bk.example:8443/a", page), "");
  assert.equal(referrerLabel("http://bk.example/other", "https://bk.example:8790/guide"), "");
  assert.equal(referrerLabel("http://[2001:db8::1]/a", "http://[2001:db8::1]:8790/guide"), "");
  assert.equal(referrerLabel(`http://${"a".repeat(300)}/`, page), "");
  assert.equal(referrerLabel(`http://${"a".repeat(64)}.example/`, page), "");
  const long = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(long.length, 253);
  assert.equal(referrerLabel(`http://${long}/`, page), long);
});

test("pageView counts one canonical page and drops the rest", () => {
  const visit = (url: string, headers: Record<string, string> = {}) =>
    pageView(new Request(url, { headers: { "user-agent": "Mozilla/5.0", ...headers } }), html(), articles);
  assert.deepEqual(visit("https://bk.example/guide.html", { referer: "https://bk.example/" }), { path: "/guide", referrer: "" });
  assert.deepEqual(visit("https://bk.example/guide?x=1"), { path: "/guide", referrer: "" });
  assert.equal(visit("https://bk.example/pay/"), null);
  assert.equal(visit("https://bk.example/not-a-page"), null);
  assert.equal(visit("https://bk.example/", { "user-agent": "Googlebot/2.1" }), null);
  assert.equal(visit("https://bk.example/", { "sec-fetch-dest": "iframe" }), null);
  assert.equal(pageView(new Request("https://bk.example/"), new Response("", { status: 404, headers: { "content-type": "text/html" } }), articles), null);
  assert.equal(pageView(new Request("https://bk.example/x.js"), new Response("", { headers: { "content-type": "text/javascript" } }), articles), null);
});

test("each page stores at most 32 foreign referrer hosts", async () => {
  const db = testDatabase();
  const day = "2026-10-13";
  await countPageView(db, { path: "/guide", referrer: "" }, day);
  await countPageView(db, { path: "/guide", referrer: "other" }, day);
  for (let i = 1; i <= 32; i++) await countPageView(db, { path: "/guide", referrer: `host-${i}.example` }, day);
  await countPageView(db, { path: "/guide", referrer: "host-1.example" }, day);
  await countPageView(db, { path: "/guide", referrer: "host-33.example" }, day);
  await countPageView(db, { path: "/guide", referrer: "host-34.example" }, day);
  await countPageView(db, { path: "/method", referrer: "host-33.example" }, day);

  const rows = (await db.prepare(`SELECT path, referrer, views FROM page_views WHERE day = ? ORDER BY path, referrer`).bind(day).all<{ path: string; referrer: string; views: number }>()).results;
  const guide = rows.filter((row) => row.path === "/guide");
  assert.equal(guide.length, 34);
  assert.deepEqual(guide.find((row) => row.referrer === ""), { path: "/guide", referrer: "", views: 1 });
  assert.deepEqual(guide.find((row) => row.referrer === "host-1.example"), { path: "/guide", referrer: "host-1.example", views: 2 });
  assert.deepEqual(guide.find((row) => row.referrer === "host-32.example"), { path: "/guide", referrer: "host-32.example", views: 1 });
  assert.equal(guide.find((row) => row.referrer === "host-33.example"), undefined);
  assert.deepEqual(guide.find((row) => row.referrer === "other"), { path: "/guide", referrer: "other", views: 3 });
  assert.deepEqual(rows.find((row) => row.path === "/method"), { path: "/method", referrer: "host-33.example", views: 1 });
});
