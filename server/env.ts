import type { D1Database, Fetcher } from "./cloudflare.ts";

/** Bindings and secrets the Worker receives (wrangler.jsonc, `wrangler secret put`, .dev.vars locally). */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** The site's own address, e.g. https://bridgekit.example. */
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ANTHROPIC_API_KEY?: string;
  /** Without these two, sign-in emails are written to the Worker log instead of sent (local development). */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_ID?: string;
  /** "sandbox" (default) or "live". */
  PADDLE_ENVIRONMENT?: string;
}
