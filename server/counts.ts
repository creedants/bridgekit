import type { D1Database } from "./cloudflare.ts";

/**
 * Page counts without a tracking script. The Worker already serves every
 * page, so it adds one to a daily total for that page and the website the
 * visitor came from. Nothing about the visitor is kept: no IP address, no
 * cookie, no browser details. Nothing inside the tool is counted, only that
 * /app/ was opened.
 *
 * A known page is stored once, whichever address was requested. A new foreign
 * host is stored only while that page and day have fewer than 32. A host
 * already stored for that page and day keeps its row. Further new hosts add
 * to the stored referrer `other`.
 */

const BOTS = /bot|crawl|spider|slurp|preview|monitor|lighthouse|headless|curl|wget|python|httpclient|java\//i;
const OVERFLOW = "other";
export const REFERRER_HOST_CAP = 32;
const STORED_HOST_LIMIT = 200;

/** The path to store for a known page, or null when the address is not one. */
export function canonicalPagePath(address: string, articles: ReadonlySet<string>): string | null {
  let pathname: string;
  try {
    pathname = new URL(address, "https://count.local").pathname;
  } catch {
    return null;
  }
  if (pathname === "/" || pathname === "/app/") return pathname;
  if (articles.has(pathname)) return pathname.endsWith(".html") ? pathname.slice(0, -".html".length) : pathname;
  if (articles.has(`${pathname}.html`)) return pathname;
  return null;
}

/** The foreign host to store, or "" for a direct visit, the same site, or a host that is not stored. */
export function referrerLabel(referer: string | null, pageUrl: string): string {
  if (!referer) return "";
  try {
    const from = new URL(referer);
    const page = new URL(pageUrl);
    const host = bareHostname(from.hostname);
    if (host === bareHostname(page.hostname)) return "";
    return isStoredHost(host) ? host : "";
  } catch {
    // No referrer, or not a URL: counted as direct.
    return "";
  }
}

/** The path and referring site to count, or null when the request is not a person opening a known page. */
export function pageView(request: Request, response: Response, articles: ReadonlySet<string>): { path: string; referrer: string } | null {
  if (request.method !== "GET" || response.status !== 200) return null;
  if (!response.headers.get("content-type")?.includes("text/html")) return null;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return null;
  if (BOTS.test(request.headers.get("user-agent") ?? "")) return null;
  const path = canonicalPagePath(request.url, articles);
  if (path === null) return null;
  return { path, referrer: referrerLabel(request.headers.get("referer"), request.url) };
}

export async function countPageView(db: D1Database, view: { path: string; referrer: string }, day: string): Promise<void> {
  // "" and "other" do not use one of the 32 host slots. A host already stored for this day and path keeps its row.
  await db
    .prepare(
      `INSERT INTO page_views (day, path, referrer, views)
       SELECT ?1, ?2,
         CASE
           WHEN ?3 = '' OR ?3 = ?4 THEN ?3
           WHEN EXISTS (
             SELECT 1 FROM page_views
             WHERE day = ?1 AND path = ?2 AND referrer = ?3
           ) THEN ?3
           WHEN (
             SELECT COUNT(*) FROM page_views
             WHERE day = ?1 AND path = ?2 AND referrer <> '' AND referrer <> ?4
           ) < ?5 THEN ?3
           ELSE ?4
         END,
         1
       ON CONFLICT (day, path, referrer) DO UPDATE SET views = views + 1`,
    )
    .bind(day, view.path, view.referrer, OVERFLOW, REFERRER_HOST_CAP)
    .run();
}

function bareHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]") && hostname.length > 2) return hostname.slice(1, -1);
  return hostname;
}

function isStoredHost(host: string): boolean {
  if (host.length > STORED_HOST_LIMIT) return false;
  if (host.includes(":")) return host.length >= 2 && host.length <= 45 && /^[0-9a-f:.]+$/.test(host);
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
  }
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
