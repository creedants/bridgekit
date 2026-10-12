import type { D1Database, Fetcher, RateLimit } from "./cloudflare.ts";

/** Bindings and secrets the Worker receives (wrangler.jsonc, `wrangler secret put`, .dev.vars locally). */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** The site's own address, e.g. https://bridgekit.example. */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  /** Without both, email is sent through Resend. With one missing, see LOCAL_EMAIL_LOG. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /**
   * On only when the value is exactly "on". A local development deployment sets
   * it, so a missing mail key writes the email to the Worker log instead of
   * failing. Production never sets it: a missing, empty or misspelled value
   * means production, where a missing mail key is an error and no email, link
   * or address reaches the log.
   */
  LOCAL_EMAIL_LOG?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_ID?: string;
  /** "sandbox" (default) or "live". */
  PADDLE_ENVIRONMENT?: string;
  /** Off unless the value is exactly "on". */
  ACCOUNTS?: string;
  MAGIC_LINK_RATE_LIMIT?: RateLimit;
}
