import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Prefer the TypeScript source files over stale compiled JS siblings.
    // This lets imports like `./App` resolve to `App.tsx` instead of `App.js`.
    extensions: [".mjs", ".tsx", ".ts", ".jsx", ".js", ".json"],
  },

  server: {
    // Pre-transform the modules every page hits so the first browser
    // request doesn't cascade through them serially.
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/auth/AuthContext.tsx",
        "./src/auth/Login.tsx",
        "./src/components/Layout.tsx",
        "./src/components/Header.tsx",
        "./src/components/ProtectedRoute.tsx",
      ],
    },

    proxy: {
      "/api": "http://localhost:8080",
      "/gmail": "http://localhost:8080",
      "/oauth": "http://localhost:8080",
      "/ws": "ws://localhost:8080",
    },
  },

  // Pre-bundle deps used by every page so the first cold load doesn't
  // discover them lazily and trigger a re-bundle mid-session.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "jwt-decode",
    ],
  },

  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    // Strip all console.* calls and debugger statements from the PRODUCTION
    // bundle so internal logging never reaches an end user's dev console.
    // Vite 8 uses Rolldown; dropConsole/dropDebugger live in its minifier's
    // compress options. Dev (`vite serve`) keeps full logging.
    rolldownOptions:
      command === "build"
        ? {
            output: {
              minify: {
                compress: { dropConsole: true, dropDebugger: true },
                mangle: true,
                codegen: { removeWhitespace: true },
              },
            },
          }
        : {},
  },
}));
