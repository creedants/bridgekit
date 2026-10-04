import type { D1Database } from "./cloudflare.ts";

/**
 * Page counts without a tracking script. The Worker already serves every
 * page, so it adds one to a daily total for the page's path and the website
 * the visitor came from. Nothing about the visitor is kept: no IP address,
 * no cookie, no browser details. Nothing inside the tool is counted, only
 * that /app/ was opened.
 */

const BOTS = /bot|crawl|spider|slurp|preview|monitor|lighthouse|headless|curl|wget|python|httpclient|java\//i;

/** The path and referring site to count, or null when the request is not a person opening a page. */
export function pageView(request: Request, response: Response): { path: string; referrer: string } | null {
  if (request.method !== "GET" || response.status !== 200) return null;
  if (!response.headers.get("content-type")?.includes("text/html")) return null;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return null;
  if (BOTS.test(request.headers.get("user-agent") ?? "")) return null;
  const url = new URL(request.url);
  let referrer = "";
  try {
    const from = new URL(request.headers.get("referer") ?? "");
    if (from.host !== url.host) referrer = from.host;
  } catch {
    // No referrer, or not a URL: counted as direct.
  }
  return { path: url.pathname.slice(0, 200), referrer: referrer.slice(0, 200) };
}

export async function countPageView(db: D1Database, view: { path: string; referrer: string }, day: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO page_views (day, path, referrer, views) VALUES (?, ?, ?, 1)
       ON CONFLICT (day, path, referrer) DO UPDATE SET views = views + 1`,
    )
    .bind(day, view.path, view.referrer)
    .run();
}
