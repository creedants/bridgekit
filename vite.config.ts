import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        method: resolve(import.meta.dirname, "method.html"),
        guide: resolve(import.meta.dirname, "guide.html"),
        app: resolve(import.meta.dirname, "app/index.html"),
      },
    },
  },
});
