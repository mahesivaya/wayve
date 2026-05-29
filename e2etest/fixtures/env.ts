// Single source of truth for the URLs the suite talks to. Override via
// env vars at run time (e.g. E2E_BASE_URL=https://staging.example test).
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost";
export const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8080";
export const MAILHOG_API = process.env.E2E_MAILHOG_API ?? "http://localhost:8025";
