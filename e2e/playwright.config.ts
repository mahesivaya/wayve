import { defineConfig, devices } from "@playwright/test";

// E2E config — runs against the docker-compose stack brought up by either
// scripts/smoke.sh (locally) or .github/workflows/e2e.yml (CI). The base URL
// is the nginx-fronted frontend on :80; backend calls are proxied through it.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:80";

export default defineConfig({
  testDir: "./tests",
  // Cap the total run so a hung browser never blocks CI indefinitely.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // Forbid `test.only` in CI — a stray .only would silently skip the rest.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI gets one worker by default to avoid step-on-each-other failures when
  // tests share the backend (e.g. duplicate-email register flow).
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : "list",

  use: {
    baseURL,
    // Capture artifacts only on failure — keeps the green-path runs cheap.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Webkit / firefox left commented intentionally — chromium is enough for
    // golden-path coverage. Add them when a real Safari / Firefox regression
    // appears, not preemptively (every extra browser ~triples CI minutes).
    // { name: "webkit",   use: { ...devices["Desktop Safari"] } },
    // { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
  ],
});
