import { defineConfig, devices } from "@playwright/test";

// Endpoints discovered on the local docker stack:
//   Frontend (nginx): http://localhost   (port 80, the URL real users hit)
//   Backend  (actix): http://localhost:8080/api
//   Mailpit  (smtp catch + web UI): http://localhost:8025
//
// All three are reachable when you've run `just docker-up-detached` or
// `docker compose -f infra/docker-compose.yml up -d` from the repo root.
// The suite assumes the stack is already up — it does NOT start it for
// you, because rebuilding the stack on every test run is expensive and
// the harness CI workflow already brings it up via scripts/smoke.sh.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost";
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8080";
const MAILPIT_API = process.env.E2E_MAILPIT_API ?? "http://localhost:8025";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./fixtures/global-setup.ts",
  // Test files use seeded users with random emails (see fixtures/user.ts)
  // so they can in principle run in parallel. Start at 1 worker while we
  // grow the suite — once we add per-test cleanup we can bump this.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Reporter: HTML for human review, list for terminal noise, JSON for
  // CI consumption. All artifacts land under test-results/.
  reporter: [
    ["list"],
    ["html", { outputFolder: "test-results/html", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  outputDir: "test-results/artifacts",
  use: {
    baseURL: BASE_URL,
    // Inject the API + Mailpit URLs via context so fixtures can read them
    // without re-importing process.env in every spec.
    extraHTTPHeaders: {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

// Re-exported so fixtures can import the resolved URLs without importing
// the whole config object.
export const ENV = {
  BASE_URL,
  API_BASE,
  MAILPIT_API,
};
