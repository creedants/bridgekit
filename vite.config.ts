import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { applyFeatureBlocks } from "./scripts/feature-blocks.ts";
import { PAY_POLICY, TOOL_POLICY } from "./scripts/policy.ts";

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml(html, context) {
      const policy = context.path.startsWith("/pay/") ? PAY_POLICY : TOOL_POLICY;
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="referrer" content="no-referrer" />`,
      );
    },
  };
}

// Keeps or drops wording for optional features; see scripts/feature-blocks.ts.
function featureBlocks(enabled: Record<string, boolean>): Plugin {
  return { name: "feature-blocks", transformIndexHtml: (html) => applyFeatureBlocks(html, enabled) };
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
      featureBlocks({
        ai: env.VITE_AI_COMMENTARY === "1",
        counts: env.VITE_PAGE_COUNTS === "1",
        workspaces: env.VITE_WORKSPACES === "1",
      }),
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
          terms: resolve(import.meta.dirname, "terms.html"),
          article: resolve(import.meta.dirname, "price-volume-mix-analysis.html"),
          groupingLevel: resolve(import.meta.dirname, "grouping-level.html"),
          app: resolve(import.meta.dirname, "app/index.html"),
          ...(env.VITE_WORKSPACES === "1" ? { pay: resolve(import.meta.dirname, "pay/index.html") } : {}),
        },
      },
    },
  };
});
