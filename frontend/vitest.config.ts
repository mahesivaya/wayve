import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Defensive: prefer the TypeScript source over any `.js` sibling. Vite's
    // default extension order would resolve `import "./AuthContext"` to a
    // `.js` file when both exist. The repo doesn't currently ship stale
    // siblings (they were removed), but a stray build artifact or
    // intermediate compile output would silently shadow the source again
    // without this override.
    extensions: [".mjs", ".tsx", ".ts", ".jsx", ".js", ".json"],
  },
  test: {
    environment: "jsdom",
    pool: "forks",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
