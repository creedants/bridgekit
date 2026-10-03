import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// The built pages may only talk to their own origin, so the tool cannot send
// data anywhere even if a dependency tried to. Not applied in dev, where Vite
// needs inline scripts and a websocket for reloading.
const TOOL_POLICY = [
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

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${TOOL_POLICY}" />\n    <meta name="referrer" content="no-referrer" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        method: resolve(import.meta.dirname, "method.html"),
        guide: resolve(import.meta.dirname, "guide.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        article: resolve(import.meta.dirname, "price-volume-mix-analysis.html"),
        app: resolve(import.meta.dirname, "app/index.html"),
      },
    },
  },
});
