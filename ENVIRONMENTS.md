# Environments

The project now has explicit development and production configuration paths. Real env files are ignored by git; use the checked-in `.example` files as templates.

## Development

Create local env files:

```sh
cp .env.development.example .env.development
cp backend/.env.development.example backend/.env.development
cp frontend/.env.development.example frontend/.env.development
cp infra/.env.development.example infra/.env.development
```

Start the development stack from the repo root:

```sh
docker compose -f infra/docker-compose.dev.yml --env-file infra/.env.development up --build
```

Or, if your current directory is `infra/`, use paths relative to `infra/`:

```sh
docker compose -f docker-compose.dev.yml --env-file .env.development up --build
```

Development runs:

- frontend: Vite dev server in `frontend/Dockerfile.dev`
- nginx: `infra/nginx/nginx.dev.conf.template`
- database env: `.env.development`
- backend env: `backend/.env.development`
- frontend env: `frontend/.env.development`
- infra/nginx env: `infra/.env.development`
- optional workers: add `--profile workers`

The dev CSP allows Vite's inline style/script behavior. Use the production stack to verify strict CSP behavior.

## macOS Local Development

For the fastest local loop on macOS, run Postgres/Redis in Docker and run the frontend/backend directly on the host:

```sh
cd infra
docker compose -f docker-compose.dev.yml --env-file .env.development up -d postgres_db redis mailhog
```

Run the backend:

```sh
cd backend
RWAYVE_ENV=development cargo run
```

Run the frontend:

```sh
cd frontend
npm run dev
```

For Google OAuth in this local setup, your Google Cloud OAuth client must include this exact authorized redirect URI:

```text
http://localhost:8080/oauth/callback
```

The backend receives the callback on port `8080`, then sends the browser back to the Vite app at `http://localhost:5173`.

## Production

Create production env files:

```sh
cp .env.production.example .env.production
cp backend/.env.production.example backend/.env.production
cp frontend/.env.production.example frontend/.env.production
cp infra/.env.production.example infra/.env.production
```

Before starting production, replace every placeholder secret and host value. Generate strong values, for example:

```sh
openssl rand -hex 64
openssl rand -hex 32
```

Start the production stack from the repo root:

```sh
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production up -d --build
```

Or, if your current directory is `infra/`, use:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Production runs:

- frontend: static Vite build in `frontend/Dockerfile.prod`, served by `frontend/nginx.prod.conf`
- nginx: `infra/nginx/nginx.prod.conf.template`
- database env: `.env.production`
- backend env: `backend/.env.production`
- frontend: environment-agnostic build — reads its API/WS base at runtime from the backend's `GET /api/config` (`PUBLIC_API_URL` / `PUBLIC_WS_URL`), so the same image runs anywhere
- infra/nginx env: `infra/.env.production`
- backend workers: enabled by default

Production does not publish Postgres, Redis, backend, or frontend directly to the host. Only nginx publishes port `80`.

## Local Backend Without Docker

The backend loads env files in this order when running locally:

1. `.env`
2. `ENV_FILE`, when set
3. `.env.${RWAYVE_ENV}` or `.env.${ENV}`
4. `backend/.env.${RWAYVE_ENV}` or `backend/.env.${ENV}`
5. `backend/.env`

For an explicit local production-style run:

```sh
ENV_FILE=backend/.env.production cargo run
```

## Configuration reference

All backend configuration is centralized: only `backend/src/config.rs` (app
settings) and `backend/src/external.rs` (external endpoint URLs) read env vars —
nothing else calls `std::env::var`. To add a setting, add an accessor in
`config.rs` and a row below. `config::validate()` runs at startup: it fails fast
on a missing **required** var and logs which optional integrations are enabled.

The frontend has no compiled-in config — `GET /api/config` serves `PUBLIC_API_URL`
/ `PUBLIC_WS_URL` / `STRIPE_PUBLISHABLE_KEY` at runtime, so one build runs in any
environment.

### Required

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | HS256 token signing secret (startup panics if missing/placeholder) |
| `AES_KEY` | AES-256-GCM at-rest key, Hex64 (startup panics if missing) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Database connection parts |
| `FRONTEND_URL` | App origin — CORS allowlist + OAuth/email links (required in production) |

### Core (have defaults)

| Variable | Default | Purpose |
|---|---|---|
| `RWAYVE_ENV` / `ENV` | `development` | Selects which `.env.<env>` files load |
| `RWAYVE_ROLE` | `api` | `api` \| `email-sync-worker` \| `email-body-worker` \| `all` |
| `PORT` | `8080` | Backend listen port |
| `DATABASE_URL` | derived from `POSTGRES_*` | Explicit connection string (wins if set) |
| `DATABASE_MAX_CONNECTIONS` | role-based (10 / 5) | Postgres pool size |
| `POSTGRES_HOST` | `localhost` | DB host (`postgres_db` in docker) |
| `REDIS_URL` | `redis://redis:6379` | Redis connection (best-effort cache) |
| `BACKEND_URL` | _(unset)_ | Backend public origin for the OAuth redirect URI |
| `PUBLIC_API_URL` / `PUBLIC_WS_URL` | _(empty ⇒ same-origin)_ | Frontend's API/WS base, served via `/api/config` |
| `AUTH_COOKIE_SECURE` | `false` | `Secure` attribute on the auth cookie (set `true` in prod) |
| `AES_HKDF_SALT` | built-in | HKDF salt — keep stable forever once set |
| `ENV_FILE` | _(unset)_ | Extra env file to load before the standard layering |

### SMTP (required for outbound email)

`SMTP_HOST`, `SMTP_PORT` (default `587`), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
(defaults to `SMTP_USER`).

### Optional integrations (feature disabled when unset)

| Integration | Variables |
|---|---|
| Google / Gmail | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET_PATH`, `GOOGLE_OAUTH_REDIRECT_URI` |
| Outlook / Microsoft | `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI`, `OUTLOOK_TENANT_ID`, `MICROSOFT_AUTHORITY` |
| Zoom | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` |
| AI | `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.0-flash`) |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` |

### External endpoint overrides (`external.rs`)

`GOOGLE_TOKEN_URL`, `GOOGLE_USERINFO_URL`, `GMAIL_SEND_URL`, `GMAIL_API_BASE`,
`GEMINI_API_BASE`, `ZOOM_OAUTH_TOKEN_URL`, `ZOOM_API_BASE`, `MICROSOFT_GRAPH_BASE`,
`GOOGLE_CALENDAR_URL`, `STRIPE_API_BASE` — each defaults to the real provider
endpoint; overridden only by tests (wiremock) or self-hosted gateways.

### Tuning & infra

`LOCAL_JSON_CACHE_TTL_SECS` (60), `LOCAL_JSON_CACHE_MAX_CAPACITY` (10000),
`TRACING_LOG_MAX_BYTES`, `TRACING_LOG_MAX_ARCHIVES`; nginx: `CSP_CONNECT_SRC`,
`NGINX_HOST` (in `infra/.env.<env>`). Frontend build-time `VITE_API_URL` /
`VITE_WS_URL` remain as optional overrides but are superseded by `/api/config`.
