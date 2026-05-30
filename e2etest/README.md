# e2etest — Playwright suite for rwayve

End-to-end tests that drive the running app (via Chromium) and the
backend JSON API directly. Intended for local-dev validation and as a
foundation for CI smoke checks.

## Prerequisites

The suite assumes the dev stack is **already running**. Bring it up
from the repo root before running anything here:

```bash
# From rwayve/
docker compose -f infra/docker-compose.yml up -d
# Or: just docker-up-detached
```

That gives you:

| Service  | URL                       | Used by suite                       |
| -------- | ------------------------- | ----------------------------------- |
| nginx    | <http://localhost>        | Page navigations (UI tests)         |
| backend  | <http://localhost:8080>   | API calls + seeding fixtures        |
| postgres | localhost:5432            | (indirect — through backend)        |
| redis    | localhost:6379            | Rate-limit key flush in setup       |
| Mailpit  | <http://localhost:8025>   | Reset-token retrieval (when wired)  |

Override any of these with env vars:

```bash
E2E_BASE_URL=http://localhost \
E2E_API_BASE=http://localhost:8080 \
E2E_MAILPIT_API=http://localhost:8025 \
E2E_REDIS_HOST=127.0.0.1 \
E2E_REDIS_PORT=6379 \
  npm test
```

## Install

```bash
cd e2etest
npm install
npx playwright install chromium
```

Subsequent runs only need `npm install` after dependency bumps; the
browser binary is cached under `~/Library/Caches/ms-playwright` on
macOS (or the platform equivalent).

## Run

```bash
# Default — headless, list + HTML reporter, all specs
npm test

# Watch a single spec while developing
npx playwright test tests/auth/login.spec.ts

# UI mode — interactive runner with time-travel debugging
npm run test:ui

# Headed (you can see the browser)
npm run test:headed

# Open the last HTML report
npm run report
```

## What's covered

Round-one coverage — ten critical-path specs across thirteen tests:

| Area      | Spec                              | What it asserts                                                  |
| --------- | --------------------------------- | ----------------------------------------------------------------- |
| Public    | `public/home.spec.ts`             | Wordmark renders, Login CTA navigates to `/login`                |
| Auth      | `auth/signup.spec.ts`             | UI signup lands the user inside the app (sidebar visible)        |
| Auth      | `auth/login.spec.ts`              | Seeded user logs in; wrong password is rejected                  |
| Auth      | `auth/reset.spec.ts`              | Forgot → token via Mailpit → reset → login (skipped without smtp)|
| Pricing   | `pricing/plans.spec.ts`           | Anonymous /pricing shows Basic, Advance, Enterprise tiers        |
| Emails    | `emails/empty.spec.ts`            | Fresh user sees the Accounts header and add-account "+"           |
| Scheduler | `scheduler/create.spec.ts`        | Authenticated user can open `/scheduler`                          |
| Notes     | `notes/crud.spec.ts`              | API create+list works; users can't read each other's notes        |
| RBAC      | `rbac/personal-blocked.spec.ts`   | Personal user gets 403/404 on `/api/platform/*` + `/api/security/audit` |
| API       | `api/unread-count.spec.ts`        | New endpoint returns `count:0` with auth, `401` without           |

## What's NOT covered (yet)

- OAuth flows (Gmail / Outlook / Yahoo) — would need provider mocks
  (see `backend/src/external::gmail_api_base()` wiremock pattern).
- Stripe billing — would need test-mode keys + webhook simulation.
- Chat / WebSocket flows — would need fixtures for E2E key exchange.
- File uploads to Drive — would need binary fixtures + storage backend.
- Org / platform admin flows — would need a seeded org with multiple
  members at different roles.
- Recovery-mode "full" mnemonic exchange — would need the 24-word
  generation + RSA envelope handling from `frontend/src/crypto/`.

Each of these is a self-contained second-round add. Ask and I'll
scaffold any of them next.

## Architecture notes

- **Single worker** by default (`workers: 1` in `playwright.config.ts`).
  The seed helper randomises emails so the suite *can* run parallel,
  but the auth rate limiter (5 registrations / 5min per IP) becomes the
  bottleneck — we mitigate by flushing the Redis `rl:*` keys before
  each register call. Parallel runs from the same IP would compete for
  flushes; raise `workers` to N after confirming Redis flush ordering.

- **No DB cleanup.** Tests leak unique-email users into the dev DB.
  Reset with `just db-reset` (wipes the volume) when you want a clean
  slate. Doing per-test cleanup would couple every test to a
  `DELETE FROM users WHERE email = $1` which is fragile across schema
  changes.

- **Why no Cypress?** Cypress and Playwright solve the same problem;
  Playwright wins on multi-tab / multi-origin support, speed, and
  trace viewer. Pick one or you duplicate every fixture.

## Results / artifacts

Run output lands under `test-results/`:

```
test-results/
  results.json         # machine-readable results (CI consumption)
  html/                # human-readable HTML report (open with `npm run report`)
  artifacts/           # screenshots, videos, traces (on failure)
```

The full directory is gitignored — re-run to regenerate.

## Adding a new test

1. Drop a `*.spec.ts` under `tests/<area>/`.
2. Use `registerUser()` from `fixtures/user.ts` when you need a fresh
   authenticated session — it self-resets the rate limiter and retries
   on 429.
3. For UI flows, drive through helpers in `fixtures/auth-actions.ts` so
   the spec doesn't break when a placeholder text changes.
4. For API assertions, use `apiGet` / `apiPost` from `fixtures/api.ts`
   and pass `{ Authorization: \`Bearer ${user.token}\` }` for auth.
5. Run just your new spec while iterating:
   `npx playwright test tests/<area>/<your-spec>.spec.ts --headed`.

## Troubleshooting

- **All tests fail with 429 / "Rate limit exceeded"** — Redis at
  `localhost:6379` isn't reachable, so the global setup couldn't flush
  the limiter. Confirm the dev stack is up and the port is exposed
  (`docker ps | grep redis`).
- **`auth/reset` skips** — backend `SMTP_HOST` isn't pointing at
  Mailpit. Set `SMTP_HOST=mailpit SMTP_PORT=1025` on the backend
  container to enable the round-trip.
- **`waitForURL` timeouts after a UI navigation** — the dockerised
  frontend takes longer to compile the first time after a rebuild.
  Re-run; subsequent runs are fast.
