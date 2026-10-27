// The few Cloudflare runtime types the server uses. Declared here rather than
// pulling in @cloudflare/workers-types globally, whose Request and Response
// clash with the DOM types the rest of the repo is checked against.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<unknown>;
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A message Email Routing hands to the Worker's email handler. Only the members
 * the Worker uses; `reply` is left out so nothing here can send mail back.
 */
export interface ForwardableEmailMessage {
  /** The envelope sender (MAIL FROM). Empty for a bounce. */
  readonly from: string;
  /** The envelope recipient (RCPT TO). */
  readonly to: string;
  readonly headers: Headers;
  /** The whole message as sent. A stream: it can be read once. */
  readonly raw: ReadableStream<Uint8Array>;
  /** Size of `raw` in bytes, given by the platform. */
  readonly rawSize: number;
  /** Refuses the message with a permanent SMTP error. */
  setReject(reason: string): void;
  /** Sends the message on to a verified Email Routing destination. */
  forward(to: string): Promise<unknown>;
}

/** The event a cron trigger hands to the Worker's scheduled handler. */
export interface ScheduledController {
  /** When the trigger was due, in milliseconds since the epoch. */
  readonly scheduledTime: number;
  readonly cron: string;
}
