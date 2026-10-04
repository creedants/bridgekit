// Content security policies for the built pages. vite.config.ts puts them in
// each page; public/_headers sends them as response headers too, which is what
// covers the database worker. test/policy.test.ts keeps the two in step.

// The site may only talk to its own origin, so the tool cannot send data
// anywhere even if a dependency tried to. Not applied in dev, where Vite needs
// inline scripts and a websocket for reloading.
export const TOOL_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

// The checkout page (workspace builds only) is the one exception: Paddle's
// script and checkout run there, and nowhere else.
export const PAY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://cdn.paddle.com",
  "frame-src https://*.paddle.com",
  "connect-src 'self' https://*.paddle.com",
  "img-src 'self' data: https://*.paddle.com",
  "style-src 'self' 'unsafe-inline' https://*.paddle.com",
  "font-src 'self' https://*.paddle.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");
