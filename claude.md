# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

- `backend/` — Rust + Actix Web 4 server (single crate, name `rwayve`). Postgres via sqlx, Redis for cache, Gmail OAuth + sync, WebSocket chat/call, AES-256-GCM at-rest encryption.
- `frontend/` — React 18 + TypeScript + Vite. React Compiler is enabled (via `@vitejs/plugin-react`). React Router v7.
- `infra/` — `docker-compose.yml` (postgres, redis, backend, frontend, nginx; `mailhog` under the `mail` profile), `justfile` of common commands, `postgres/init.sql` (the canonical schema), `nginx/nginx.conf`.
- `scripts/smoke.sh` — end-to-end docker smoke that brings up the stack and hits a handful of endpoints. Used by CI.
- `.github/workflows/smoke.yml` — runs backend `cargo test`, frontend `tsc --noEmit` + `vitest`, then the docker smoke.

Env files: root `.env` (compose / postgres creds), `backend/.env` (loaded by `dotenvy`; also loaded from the repo root when `cargo run` is invoked from there — see `load_env_files` in `backend/src/main.rs`), `frontend/.env` (`VITE_API_URL`, baked at build time).

## Common commands

Backend (Rust, in `backend/`):
- `cargo run` — start server on `:8080` (requires `DATABASE_URL` and `FRONTEND_URL`).
- `cargo build` / `cargo build --release`.
- `cargo clippy -- -D warnings` — lint (denies warnings; see `clippy.toml` below).
- `cargo fmt`.
- `cargo test --no-fail-fast -- --test-threads=1` — CI runs single-threaded; tests mutate process env and use `serial_test`.
- Single test: `cargo test <name_substring>` or `cargo test -- --exact <full::path>`.
- Tests need `TEST_DATABASE_URL` or `DATABASE_URL` against a Postgres that has `infra/postgres/init.sql` applied (`psql "$DATABASE_URL" -f infra/postgres/init.sql`).

Frontend (in `frontend/`):
- `npm run dev` — Vite dev server on `:5173`, proxies `/api`, `/gmail`, `/oauth` to backend `:8080` and `/ws` over WebSocket.
- `npm run build` — `tsc -b && vite build`.
- `npm run lint` — ESLint flat config.
- `npm test` — Vitest (jsdom). Watch: `npm run test:watch`. UI: `npm run test:ui`.
- Single test: `npx vitest run path/to/file.test.tsx -t "test name"`.
- Type-check only: `npx tsc --noEmit`.

Docker / full stack (from `infra/` via `just`, or from repo root with `docker compose -f infra/docker-compose.yml ...`):
- `just docker-up` / `just docker-up-detached` / `just docker-down`.
- `just db-shell` — `psql` into the running `postgres_db` container as `wayve_user`.
- `just db-reset` — wipes the volume and restarts postgres (re-runs `init.sql`).
- Smoke: `./scripts/smoke.sh` (set `KEEP_RUNNING=1` to leave the stack up).
- MailHog (catches outbound SMTP, UI at `http://localhost:8025`): `docker compose -f infra/docker-compose.yml --profile mail up -d mailhog`.

## Backend architecture

Entry point `backend/src/main.rs`:
- Registers feature modules (`ai`, `cache`, `call`, `chat`, `drive`, `email`, `notes`, `routes`, `scheduler`, `security`, ...) and wires routes in `app_routes`. New HTTP handlers must be added there to be reachable.
- Routes are split between **feature modules** (`chat::handler`, `email::handler`, `notes::handler`, etc.) and a **cross-cutting `routes/` module** (`routes/auth.rs`, `routes/user.rs`, `routes/account.rs`, `routes/email.rs`) for endpoints that aren't owned by one feature.
- API surface is mounted under `/api`, with `/gmail/login`, `/oauth/callback`, `/ws/chat`, and `/ws/call` mounted at the root. Uploaded drive files are not served statically; they are delivered through authenticated `/api/files/{id}/download`.
- CORS allowlist is a **single origin** read from `FRONTEND_URL` — change it (or rework the CORS builder) for multi-origin support.
- Two background workers spawn at startup:
  - `start_sync_worker` — `email::sync::sync_all`, every 30s with exponential backoff to 5 min on error.
  - `start_body_worker` — fetches Gmail message bodies for rows where `body_encrypted = ''` (the index `idx_emails_pending_body` exists for this).
- Postgres connect loop retries forever (logs first failure verbosely, then dot-counter); Redis is best-effort — if it fails to connect, the app continues with `cache: None`.

`prelude.rs` re-exports the heavy imports (Actix, sqlx, serde, chrono, reqwest, futures, etc.) plus `MAX_EMAIL_CONCURRENCY = 20` and `BATCH_SIZE = 50`. Prefer `use crate::prelude::*;` in new files.

`clippy.toml` bans `Option::unwrap` and `Result::expect` (test code uses `unwrap_or_else(|err| panic!(...))` as the accepted workaround) and sets `too-many-arguments-threshold = 5`. Production code must propagate errors with `?` or `match`.

### Database

The schema lives in `infra/postgres/init.sql` and is applied **once** when the Postgres container first initializes (via `docker-entrypoint-initdb.d`). It is **not** managed by `sqlx migrate` despite the `just sqlx-migrate` recipe — the file is idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... IF NOT EXISTS`) and is re-applied verbatim in CI. To evolve the schema, edit this file and `just db-reset` locally.

Key tables: `users` (local + Google auth, `auth_provider` discriminator, nullable `password` for OAuth signups; `account_type` is the RBAC scope discriminator), `organizations` + `organization_members` / `platform_members` (RBAC role rows — see Authorization), `email_accounts`, `emails`, `meetings` + `meeting_participants` (with optional Zoom / Google Calendar linkage), `messages` (server-encrypted chat content, `message_status` ENUM `sent|delivered|read`), `files`, `notes`, `password_reset_tokens`, the Stripe billing projection (`plans`, `subscriptions`, `invoices`, `billing_customers`, `entitlements`, `usage_events`), and `api_keys` + `api_key_audit_log`.

Per-recipient delivery state is intended to live in a separate `message_recipients` table — **do not name it `message_status`**, which collides with the existing ENUM.

### Encryption

`security/encryption.rs` provides `encrypt`/`decrypt` (AES-256-GCM, random 12-byte nonce). `AES_KEY` should be high-entropy Hex64: 64 hex characters decoded as input key material, then expanded with HKDF-SHA512 into the 32-byte AES-256 key. `AES_HKDF_SALT` is optional; if set, keep it stable forever because changing it prevents decrypting HKDF-encrypted rows. Decrypt keeps a legacy fallback for rows encrypted with the old direct AES key. Stored ciphertext columns come in pairs: `*_iv` (base64 nonce) + `*_encrypted` (base64 ciphertext) — used for `messages.content_*` and `emails.body_*`.

Chat uses client-side envelope encryption for new direct and channel messages. The frontend encrypts content into a `WAYVE_CHAT_E2E_V1` RSA/AES hybrid envelope for every participant key before sending; `chat/websocket.rs` rejects plaintext normal messages and then applies the backend AES-GCM layer only as storage-at-rest protection for the envelope. `chat/direct_messages.rs` and `chat/channel_messages.rs` decrypt only the storage layer and return the client envelope, which the browser decrypts locally. Legacy rows or manually inserted plaintext are not E2E.

`security/jwt.rs` mints HS256 JWTs from `JWT_SECRET`. `get_user_id_from_request` is the single auth chokepoint for HTTP handlers — it also resolves API-key requests (see API keys). The WebSocket endpoints (`chat_ws`, `call_ws`) authenticate via `get_user_id_from_request` with a `?token=` query fallback, deriving `user_id` from verified credentials and **never an unverified query value** — preserve that when adding WS routes.

### Authorization (RBAC)

Two privileged scopes — **platform** and **organization** — plus personal accounts. `users.account_type` (`personal | organization | organization_admin | platform_admin`) discriminates the scope; the role *within* a scope is a row in `organization_members.role` / `platform_members.role`. Nine roles: `owner, super_admin, admin, security, billing, developer, support, member, guest` (CHECK-constrained in `init.sql`).

`security/rbac.rs` is the authority — a fixed `Permission` catalog, the role→permission matrix (`owner` = everything; `super_admin` = everything except billing), `resolve_role_context` (resolves a user's scope + role from the DB), and the request gates `require_permission` / `require_org_access`. Authorization is computed per request from the DB and **never trusted from the JWT**, so a role change takes effect on the next request. Role-management endpoints live in `routes/user.rs` (`/api/organizations/{id}/members…`, `/api/platform/members…`); `/api/me` and `/profile` return `scope` + `permissions[]`. `frontend/src/auth/permissions.ts` mirrors the matrix for UI gating only — never for real authorization. `scripts/seed_rbac_users.sh` seeds one test user per role in both scopes.

### API keys

An `X-API-KEY` header lets a service call any endpoint without a login. `middleware/api_key.rs` (`ApiKeyMiddleware`, wrapped in `main.rs`) is a no-op unless the header is present; otherwise it validates the key, enforces the route's required scope and a per-key rate limit, records the outcome in `api_key_audit_log`, and injects an `ApiKeyPrincipal` into the request extensions — which `get_user_id_from_request` returns, so a key authenticates **as a designated `user_id`** across every handler with no per-handler change.

`security/api_key.rs` owns the scope catalog, the `required_scope(method, path)` route map, `resolve_api_key`, and the audit writer. Keys are `internal` (may hold the `*` scope) or `external` (explicit scopes, mandatory expiry). Management endpoints (`/api/keys*`) are in `routes/api_keys.rs`, gated by the `api_keys:manage` permission. The raw key is shown once at creation; only its SHA-256 hash is stored.

### Logging

There are two paths:
- `tracing` + `tracing-actix-web::TracingLogger` wraps every request.
- `observability::devlog` is a small `log::Log` impl that writes to `backend/logs/dev.log` (mounted into the container via the `../logs` bind in docker-compose). It filters noisy framework targets (`hyper`, `h2`, `rustls`, `mio`, `tokio`, `sqlx::query`) above WARN. Use `target = "auth" | "ws" | "worker" | "db"` on `info!`/`warn!`/`error!` macros — existing code relies on these targets to keep `dev.log` readable.

### Backend tests

Test helpers in `backend/src/test_support.rs` (`test_pool`, `insert_local_user`, `insert_google_user`, `jwt_for`, `random_email`, `next_synthetic_user_id`).

> ⚠️ The files under `backend/src/tests/*.rs` each declare `#[cfg(test)] mod tests { ... }` with `use super::*;`, but they are **not wired into any parent module** in `main.rs` or the feature `mod.rs` files. As written they will not be compiled by `cargo test`. If you add or rely on a test in `src/tests/`, also add the inclusion (either `#[cfg(test)] #[path = "..."] mod foo_test;` in the parent module, or move the file next to its target). Don't trust a green local run unless you've confirmed the test actually executed.

Tests that mutate env vars use `#[serial_test::serial]`; CI runs `--test-threads=1` for the same reason. OAuth flows are mocked with `wiremock` and `external::gmail_api_base()` indirection (set the env var to point at the mock server). MailHog-dependent tests skip themselves when `MAILHOG_API` is unset.

## Frontend architecture

Routing in `src/App.tsx`: public routes (`/login`, `/register`, `/forgot-password`, `/reset-password`), a root `/` (Home), and protected routes (`/home`, `/emails`, `/chat`, `/scheduler`, `/drive`, `/notes`, `/aichat`, `/profile`, `/settings`) gated by `ProtectedRoute` and wrapped in `Layout`. Protected pages are `lazy()`-imported; `Layout`, `Header`, and `AuthContext` are eagerly loaded and listed in `vite.config.ts`'s `server.warmup.clientFiles`.

Auth state lives in `src/auth/AuthContext.tsx`. API base URLs come from `src/config/env.ts` (`API_BASE`, `WS_BASE`, both reading `VITE_API_URL`/`VITE_WS_URL` with localhost fallbacks). HTTP calls go through `src/api/client.ts`; auth-specific calls through `src/api/Auth.ts`.

Client-side RSA/AES hybrid encryption helpers live in `src/crypto/` (key handling). They are used by encrypted email and chat E2E envelopes (`src/chat/e2ee.ts`). Keep chat plaintext out of WebSocket payloads; only encrypted envelopes should cross the backend boundary.

### Stale `.js` siblings — important gotcha

Almost every `.tsx`/`.ts` source file under `frontend/src/` has a compiled `.js` sibling checked in (e.g. `AuthContext.tsx` and `AuthContext.js` both exist). Default Vite/Vitest resolution would prefer `.js` and load **stale** transpiled output for transitive imports like `import { AuthProvider } from "./AuthContext"`. The fix is in `vitest.config.ts` — `resolve.extensions` is reordered so `.tsx`/`.ts` win. If you create new modules: either keep the `.js` sibling in sync, delete it, or replicate the same `resolve.extensions` override in any new Vite/Vitest config — otherwise tests and prod builds will silently disagree.

### Frontend tests

Vitest + jsdom + Testing Library. Setup in `src/test/setup.ts` polyfills `localStorage`/`sessionStorage` (jsdom 29 + vitest 4 don't always expose working `Storage`) and defaults `import.meta.env.VITE_API_URL` to `http://test.local` so tests don't depend on a real `.env`. Tests live in `src/test/` (not co-located with components).

## CI

`.github/workflows/smoke.yml` has three jobs: `backend-tests` (spins up Postgres + MailHog services, applies `init.sql`, runs `cargo test --test-threads=1`), `frontend-tests` (`tsc --noEmit` + `npm test`), then `docker-smoke` (depends on both; generates throwaway `.env`s + `client_secret.json`, then runs `scripts/smoke.sh`). Match this locally before pushing breaking changes.
