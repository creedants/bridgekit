import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

// Wording for an optional feature sits between <!-- feature:NAME --> and
// <!-- /feature:NAME --> in the pages and is kept only when the feature is
// switched on, so the privacy page always describes the build it ships in.
function featureBlocks(enabled: Record<string, boolean>): Plugin {
  return {
    name: "feature-blocks",
    transformIndexHtml(html) {
      return html.replace(
        /[ \t]*<!-- feature:([a-z-]+) -->([\s\S]*?)<!-- \/feature:\1 -->\n?/g,
        (_, name: string, body: string) => (enabled[name] ? body.replace(/^\n/, "") : ""),
      );
    },
  };
}

// In development, serves the AI commentary endpoint from this server when
// ANTHROPIC_API_KEY is set (for example in .env.local), so the opt-in feature
// can be tried locally. Production hosts mount the same handler.
function devCommentary(apiKey: string | undefined): Plugin {
  return {
    name: "dev-commentary",
    apply: "serve",
    configureServer(server) {
      if (!apiKey) return;
      server.middlewares.use("/api/commentary", async (req, res) => {
        const { handleCommentary } = await server.ssrLoadModule("/server/commentary.ts");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = new Request("http://localhost/api/commentary", {
          method: req.method,
          headers: { "content-type": req.headers["content-type"] ?? "" },
          body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
        });
        const response: Response = await handleCommentary(request, { apiKey });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  return {
    plugins: [
      react(),
      contentSecurityPolicy(),
      featureBlocks({ ai: env.VITE_AI_COMMENTARY === "1" }),
      devCommentary(env.ANTHROPIC_API_KEY),
    ],
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
  };
});
