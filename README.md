# Wayve

**Wayve is a private, all-in-one workspace** — everything your team needs to communicate and get work done, brought together in a single app, with privacy built in from the ground up.

Most teams spend their day hopping between half a dozen different tools — one for email, another for chat, others for video calls, file storage, notes, and calendars. Each one is a separate login, a separate bill, and another place your company's information ends up living. Wayve replaces that patchwork with one connected workspace, so your team can do everything in a single place and your business keeps all of its information under one roof.

## What you can do with Wayve

- 📧 **Email** — send and receive messages from one inbox, without leaving the app.
- 💬 **Chat & calls** — message teammates instantly in one-to-one or group conversations, and jump straight into voice or video calls.
- 📁 **Drive** — store, organize, and share files and documents with the people who need them.
- 📝 **Notes** — capture ideas, write things down, and keep your team's knowledge in one searchable place.
- 📅 **Scheduling** — plan meetings, manage your calendar, and keep everyone on the same page.
- 🤖 **AI assistant** — get help writing messages, summarizing long threads, and quickly finding answers.

## Why it's different

**Your information stays private — by design.** Your messages and files are locked so that only you and the people you choose can open them. Not even the people running the servers can read your content, so your conversations and documents stay yours alone.

**Your business stays in control.** Because Wayve is self-hosted, your organization runs it on its own systems and fully owns its data — nothing is handed off to an outside provider. That means stronger privacy, no surprise vendor lock-in, and one tool instead of many to manage and pay for.

**Built for teams of any size.** Wayve supports individuals, organizations, and larger platforms, with flexible roles and permissions so the right people have the right level of access.

---

A self-hosted productivity suite — encrypted email, real-time chat & calls, drive, notes, scheduling, and an AI assistant — built around a zero-knowledge encryption model where the server never holds users' private keys in plaintext.

- **Backend** — Rust + Actix Web 4 (Cargo workspace: `wayve-server`/`rwayve`, `wayve-security`, `wayve-db`). Postgres via `sqlx`, Redis cache, Gmail OAuth + sync, WebSocket chat/call, AES-256-GCM at-rest encryption.
- **Frontend** — React 18 + TypeScript + Vite (React Compiler enabled), React Router v7.
- **Infra** — Docker Compose stacks for dev and prod, nginx reverse proxy, a `justfile` of common commands.

> Detailed architecture and conventions live in [CLAUDE.md](CLAUDE.md). This README is the quick-start.

## Repo layout

| Path | What's there |
|------|--------------|
| `backend/` | Rust API server, background workers, encryption, RBAC, API keys. |
| `frontend/` | React SPA. |
| `infra/` | `docker-compose*.yml`, `justfile`, `postgres/init.sql` (canonical schema), `nginx/`. |
| `e2etest/` | End-to-end tests (Playwright-style fixtures, e.g. Mailpit). |
| `scripts/` | `smoke.sh` (CI e2e), `seed_rbac_users.sh`, deploy helpers. |
| `docs/`, `documentation/` | Design notes and reference docs. |

## Prerequisites

- Rust (stable) + Cargo
- Node 18+ and npm
- Docker + Docker Compose
- A Postgres reachable for backend tests (or use the dockerized one)

## Quick start (Docker)

The fastest way to bring up the whole stack — Postgres, Redis, backend, frontend, nginx, and Mailpit:

```bash
cd infra
just dev-up-detached      # full dev stack, detached
just dev-logs             # tail logs
just dev-down             # tear down
```

- Frontend (via nginx): http://localhost
- Mailpit (captures outbound SMTP): http://localhost:8025

> `infra/postgres/init.sql` is applied **once** when the Postgres container first initializes. To evolve the schema, edit that file and `just db-reset` (wipes the volume and re-applies it). It is **not** managed by `sqlx migrate`.

## Running locally without Docker

### Backend (`backend/`)

```bash
cargo run                              # serves on :8080 (needs DATABASE_URL + FRONTEND_URL)
cargo clippy -- -D warnings            # lint (warnings denied)
cargo fmt
cargo test --no-fail-fast -- --test-threads=1   # tests mutate env; run single-threaded
```

Tests need a Postgres with the schema applied:

```bash
psql "$DATABASE_URL" -f infra/postgres/init.sql
```

### Frontend (`frontend/`)

```bash
npm install
npm run dev        # Vite dev server on :5173, proxies /api, /gmail, /oauth, /ws to :8080
npm run build      # tsc -b && vite build
npm run lint
npm test           # Vitest (jsdom)
npx tsc --noEmit   # type-check only
```

## Configuration

Environment files (not committed):

- Root `.env` — Compose / Postgres credentials and shared secrets.
- `backend/.env` — loaded by `dotenvy` (also picked up from the repo root when `cargo run` is invoked there).
- `frontend/.env` — `VITE_API_URL` / `VITE_WS_URL`, baked in at build time.

Key backend secrets: `DATABASE_URL`, `FRONTEND_URL` (single-origin CORS allowlist), `JWT_SECRET`, `AES_KEY` (Hex64, expanded via HKDF-SHA512), optional `AES_HKDF_SALT` (keep stable forever once set), Gmail OAuth credentials, Redis URL.

## Architecture highlights

- **Auth** — HS256 JWTs; `get_user_id_from_request` is the single auth chokepoint and also resolves `X-API-KEY` requests. WebSocket endpoints authenticate the same way (never trusting an unverified `?token=`).
- **RBAC** — Two privileged scopes (**platform** and **organization**) plus personal accounts. Nine roles; authorization is computed per request from the DB in `security/rbac.rs` and never trusted from the JWT.
- **Encryption** — AES-256-GCM at rest. Chat and email use client-side RSA/AES hybrid envelopes; the server stores only opaque envelopes. Organization master keys are escrowed only as wrapped copies (mnemonic-wrap + per-key-holder pubkey wrap) — the server never holds them unwrapped.
- **Background workers** — email sync (every 30s, exponential backoff) and a Gmail message-body fetcher.

## Seeding test users

```bash
scripts/seed_rbac_users.sh          # one user per RBAC role, in both scopes
# password defaults to "Mahesh"; override with SEED_PASSWORD=...
```

## Testing & CI

`.github/workflows/smoke.yml` runs three jobs:

1. **backend-tests** — Postgres + Mailpit services, applies `init.sql`, `cargo test --test-threads=1`.
2. **frontend-tests** — `tsc --noEmit` + `npm test`.
3. **docker-smoke** — brings up the full stack and hits key endpoints via `scripts/smoke.sh`.

Match these locally before pushing breaking changes.

## License

Proprietary — all rights reserved (update as appropriate).
