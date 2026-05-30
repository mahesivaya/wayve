# Wayve — Project Reference

A single-file deep dive for engineers, integrators, and procurement reviewers.
Where this doc and the code disagree, the code wins — pointers are included
throughout so a fact-check is one `Cmd-Click` away.

---

## 1. What it is

Wayve is a **multi-tenant SaaS** that bundles seven first-party products
behind a single sign-in:

- **Email** — Gmail / Outlook OAuth, IMAP-grade sync, shared inboxes
- **Chat** — Direct messages + channels, end-to-end encrypted at the envelope layer
- **Scheduler** — Meetings with optional Zoom + Google Calendar linkage
- **Drive** — Authenticated file storage with folder hierarchy + per-resource sharing
- **Notes** — Personal markdown notes (server-encrypted)
- **Tasks** — To-dos with 1-5 priority and `in_progress`/`done` status
- **AI Chat** — Google Gemini assistant

On top of those products: a programmatic **HTTP API** (X-API-KEY), an
**outbound webhooks** push surface, an **OAuth-relying-party** SSO via OIDC,
a **SCIM 2.0** service-provider for IdP provisioning, **embed tokens** for
iframe widgets, and a **per-customer rate-limit tier** ladder.

Three deployment surfaces:

- **localhost** development via Docker Compose.
- **rwayve.maheshg.me** production on AWS EC2 (instance `i-07af9db286562f5ac`),
  reverse-proxied by nginx, deployed with `scripts/deploy.sh`.
- **CI** via `.github/workflows/smoke.yml` — backend `cargo test`, frontend
  `tsc + vitest`, then the full docker smoke from `scripts/smoke.sh`.

---

## 2. Stack at a glance

| Layer | Tech |
| --- | --- |
| Backend | Rust 1.x, Actix Web 4, sqlx (async Postgres), `tracing-actix-web`, `jsonwebtoken`, `aes-gcm`, `hmac`, `bcrypt`, `reqwest`, `tokio`, `moka` |
| Frontend | React 18 + TypeScript + Vite 5, React Router v7, **React Compiler** enabled |
| DB | PostgreSQL 15 |
| Cache / queue | Redis 7 (request counters, profile cache, webhook delivery claim) |
| Search/index | (none — feature uses Postgres `ILIKE` + GIN indexes on `emails.labels`) |
| Realtime | WebSockets via `actix-web-actors` for chat and call signalling |
| Auth | HS256 JWT sessions, X-API-KEY, X-EMBED-TOKEN, OIDC (RP), SCIM bearer tokens |
| Observability | `tracing` + Jaeger, `observability::devlog` to `backend/logs/dev.log` |
| Build | Cargo (Rust), Vite (frontend), Docker Compose (orchestration), nginx (front door) |

---

## 3. Repo layout

```
.
├── backend/                Rust workspace (single crate `rwayve`)
│   ├── src/
│   │   ├── ai/             Gemini chat passthrough
│   │   ├── billing/        Stripe projection + plans + quotas + tiers
│   │   ├── cache.rs        Redis wrapper + Moka TtlCache helper
│   │   ├── call/           WebRTC signalling + Cloudflare TURN proxy
│   │   ├── chat/           Channels, DMs, websocket server
│   │   ├── config/         Env parsing, runtime role discrimination
│   │   ├── docs/           Markdown publication portal (`/docs`)
│   │   ├── drive/          Files + folders + drive_shares
│   │   ├── email/          Gmail/Outlook OAuth, sync, body worker, send, shared inboxes
│   │   ├── embed/          X-EMBED-TOKEN mint + middleware + verify
│   │   ├── middleware/     ApiKeyMiddleware, RateLimitMiddleware
│   │   ├── models/         Shared structs
│   │   ├── notes/          CRUD
│   │   ├── observability/  tracing init + devlog
│   │   ├── openapi/        Hand-curated OpenAPI 3.1 spec
│   │   ├── platform_billing/ Platform-owner billing console
│   │   ├── platform_team/  Developer/Support dashboards
│   │   ├── prelude.rs      Module-wide re-exports
│   │   ├── routes/         Cross-cutting endpoints (auth, user, audit, account)
│   │   ├── scheduler/      Meetings + Zoom + Google Calendar
│   │   ├── scim/           SCIM 2.0 service-provider (Users only)
│   │   ├── security/       RBAC, JWT, AES-GCM, API key catalog
│   │   ├── startup.rs      Self-healing schema migrator (ALTER … IF NOT EXISTS)
│   │   ├── tasks/          Tasks CRUD + webhook fan-out
│   │   ├── webhooks/       Outbound events + dispatcher worker
│   │   └── main.rs         Entrypoint
│   └── Cargo.toml
├── frontend/
│   ├── src/
│   │   ├── api/            HTTP client wrappers (one file per feature)
│   │   ├── auth/           AuthContext, accountHome, permissions
│   │   ├── billing/        Self-service billing page (Stripe)
│   │   ├── chat/           Chat UI + E2E envelope unwrap
│   │   ├── components/     Layout, ProtectedRoute, ProfileMenu, …
│   │   ├── crypto/         RSA/AES hybrid envelope helpers
│   │   ├── docs/           (none here — see `marketing/Docs.tsx`)
│   │   ├── emails/         Inbox UI + thread view
│   │   ├── marketing/      `/developers`, `/developers/quotas`, `/docs`, `/pricing`, …
│   │   ├── organization/   PlatformAdminHome, OrganizationAdminHome
│   │   ├── platformBilling/  Billing console UI
│   │   ├── platformTeam/   Developer / Support / Welcome / Secrets pages
│   │   ├── settings/       AuditSecurity, ScimTokens, Webhooks, SharedInboxes, SsoSettings
│   │   ├── tasks/, notes/, scheduler/, drive/, aichat/   Per-product UIs
│   │   └── App.tsx         Route table
│   └── package.json
├── infra/
│   ├── docker-compose.yml         Includes dev OR prod compose
│   ├── docker-compose.dev.yml
│   ├── docker-compose.prod.yml
│   ├── nginx/                     nginx.conf + nginx.prod.conf.template
│   └── postgres/init.sql          Source of truth for schema (run on first start)
├── scripts/                Smoke test + deploy + seed RBAC users
├── documentation/          Internal scratchpad notes (NOT published, see README.md there)
├── e2e/                    Playwright (smoke + auth flows)
└── wayve.md                This file
```

---

## 4. Authentication

Wayve accepts **four** authentication mechanisms. They are mutually
distinguishable by the request shape and never overlap.

### 4.1 JWT session

- Mint: `POST /api/login` → HS256-signed `Claims { sub, email, account_type, exp }`.
- Sent as `Authorization: Bearer …` or a `HttpOnly` cookie `rwayve_auth`.
- TTL: 24 hours. No refresh tokens — log in again.
- Decoded by [security/jwt.rs::decode_jwt](backend/src/security/jwt.rs).

### 4.2 X-API-KEY

- Mint: dashboard at `/api-keys` or owner-only `/platform/secrets`.
- Format: `wv_sk_<48-hex>`. Stored as SHA-256 hash + 16-char preview.
- Scoped: each key carries a `scopes[]` array; the gateway checks the
  required scope per route (see `security/api_key.rs::required_scope`).
- Rate-limited: per-key requests/min via Redis counter + plan-tier monthly
  quota across all keys for the owning user.
- Audited: every request lands in `api_key_audit_log`.
- Middleware: [middleware/api_key.rs::ApiKeyMiddleware](backend/src/middleware/api_key.rs).

### 4.3 X-EMBED-TOKEN

- Mint: `POST /api/embed/tokens` (requires session JWT).
- HS256 JWT with `iss=wayve-embed`, `aud=<origin>`, 5-min TTL, read-only scopes only.
- Verified by [embed/middleware.rs::EmbedMiddleware](backend/src/embed/middleware.rs).
  - GET/HEAD only — writes return 405.
  - The browser's `Origin` header must match `aud` — wrong origin returns 403.
- Use case: iframe widget embedding of read surfaces inside a customer app.

### 4.4 SCIM bearer

- Mint: org admin at `/settings/scim` → `wv_scim_<48-hex>`.
- Authenticates `/scim/v2/*` endpoints only — never accepted on `/api/*`.
- Org-scoped: every SCIM request is constrained to the bearer's organization.
- Validated by [scim/tokens.rs::resolve](backend/src/scim/tokens.rs).

### 4.5 OIDC SSO (Wayve as relying party)

- Configured per organization in `org_sso_configs`:
  `issuer_url`, `client_id`, `client_secret_encrypted`, `allowed_domain`, `enforce_sso`.
- Email-domain-routed: `alice@acme.com` → Acme's IdP if the org has
  `enforce_sso=true` and a matching `allowed_domain`.
- PKCE + nonce binding via `sso_states` table to prevent code interception.

---

## 5. RBAC

Three scopes — **Personal**, **Organization**, **Platform** — and **nine roles**
per scope. Roles are stored in `organization_members.role` and
`platform_members.role`; personal users are implicit owners of their own
workspace.

| Permission | owner | super_admin | admin | security | billing | developer | support | member | guest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `apps:use` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `profile:manage_self` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `members:read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `members:manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `roles:manage` | ✓ |  |  |  |  |  |  |  |  |
| `roles:assign_limited` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `apps:manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `org:settings` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `org:delete` | ✓ |  |  |  |  |  |  |  |  |
| `billing:manage` | ✓ |  |  |  | ✓ |  |  |  |  |
| `billing:read` | ✓ |  |  |  | ✓ |  |  |  |  |
| `usage:read` | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |  |  |
| `api_keys:manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| `webhooks:manage` | ✓ | ✓ |  | ✓ |  | ✓ |  |  |  |
| `integrations:manage` | ✓ | ✓ |  |  |  | ✓ |  |  |  |
| `logs:read` | ✓ | ✓ |  | ✓ |  | ✓ |  |  |  |
| `logs:read_limited` | ✓ | ✓ |  | ✓ |  | ✓ | ✓ |  |  |
| `audit:read` | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `security:manage` | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `tickets:manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `sso:manage` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |
| `inbox:manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |

`owner` always implies the full catalog. `super_admin` is the full catalog
minus `billing:*`. Authorization is computed **per request** by
`rbac::resolve_role_context` reading from the DB — role changes take effect
on the **next** request, never trusted from the JWT.

Source: [backend/src/security/rbac.rs](backend/src/security/rbac.rs).
Frontend mirror: [frontend/src/auth/permissions.ts](frontend/src/auth/permissions.ts).

---

## 6. Encryption at a glance

### 6.1 At-rest (AES-256-GCM)

- Key derivation: `AES_KEY` env (Hex64) → HKDF-SHA512 → 32-byte AES key.
- `AES_HKDF_SALT` env is optional but **must be stable forever** once set.
- Nonce: 12 bytes, random per encryption.
- API: `encrypt`, `decrypt`, `encrypt_binary`, `decrypt_binary` in
  [security/encryption.rs](backend/src/security/encryption.rs).
- Storage pattern: every encrypted column comes in a pair —
  `*_iv` (base64 nonce) + `*_encrypted` (base64 ciphertext).
- Legacy fallback decrypt tries the raw `AES_KEY` if HKDF-derived fails,
  so a key rotation never strands old data.

### 6.2 E2E chat envelope

- Format: `WAYVE_CHAT_E2E_V1\n<json>` where `<json>` is per-recipient RSA-OAEP-
  wrapped AES keys + a single AES-GCM payload.
- Client encrypts before WS send; backend rejects unwrapped messages and
  stores the envelope as-is, adding only its own at-rest AES layer.
- Unwrap happens **on the receiving client** using the recipient's private
  key (held in browser IndexedDB). The server cannot read message content.
- Helpers: [frontend/src/chat/e2ee.ts](frontend/src/chat/e2ee.ts) +
  [frontend/src/crypto/](frontend/src/crypto/).

### 6.3 Account recovery

- Each user has a server-stored "wrapped private key" (`user_wrapped_keys`)
  encrypted with PBKDF2(mnemonic). The mnemonic is shown once at signup
  and never persisted server-side.
- Recovery flow: user enters mnemonic on a new device → PBKDF2 decrypts
  the wrapped key → IndexedDB seed restored → chat history readable
  again on the new device.

---

## 7. Feature modules

Each module owns its own routes module that's registered in
`main.rs::app_routes`. Tables are documented in `infra/postgres/init.sql`;
self-healing ALTERs live in `backend/src/startup.rs`.

### 7.1 Email

- Connect: Gmail OAuth at `/gmail/login` + `/oauth/callback`; Outlook OAuth
  at `/outlook/connect-url` + `/oauth/outlook/callback`.
- Sync: 30-sec tick in `email::sync::sync_all`; pulls headers only via
  Gmail `format=metadata` / Graph `$select`.
- Body backfill: separate `body_worker` picks up rows with empty
  `body_encrypted` at 40 concurrent fetches/account.
- Send: `POST /api/email/send` proxies to Gmail or Graph based on the
  account's `provider` column.
- Attachments: `GET /api/emails/{id}/attachments` + per-attachment
  authenticated download. Body fetch is on-demand from
  `GET /api/emails/{id}/body`.
- Shared inboxes: `shared_inbox_members` + `shared_inbox_email_state` for
  support@-style team mailboxes with `open/pending/closed` statuses.
- Cross-user duplicate prevention: `email_owned_by_other_user` gate in
  the OAuth callback rejects connecting the same Gmail under two Wayve
  accounts.

Files: [backend/src/email/](backend/src/email/) + frontend [emails/](frontend/src/emails/).

### 7.2 Chat

- Two surfaces: 1-on-1 DMs (`messages` table) and channels
  (`channels` + `channel_members` + `channel_messages`).
- WebSocket: `/ws/chat`, JWT-authenticated.
- Tenant isolation: cross-scope DMs rejected at WS receive
  (personal↔personal, org↔org-same-org, platform↔platform only).
- E2E encryption: covered in §6.2.
- Channel join requests + invites via `channel_join_requests` and
  `channel_invites`.
- Threaded replies via `channel_messages.parent_message_id`.

Files: [backend/src/chat/](backend/src/chat/) + frontend [chat/](frontend/src/chat/).

### 7.3 Scheduler

- `meetings` + `meeting_participants`, with optional `zoom_join_url` /
  Google Calendar event linkage.
- Title + Zoom URL + participant emails encrypted at rest.
- Notifications: SMTP-out invites/updates/cancels on create/update/delete
  (Mailpit in dev, real SMTP in prod).
- Webhook fan-out: `meeting.created` / `.updated` / `.deleted` events.

Files: [backend/src/scheduler/](backend/src/scheduler/) + frontend
[scheduler/](frontend/src/scheduler/).

### 7.4 Drive

- `files` + `folders` + `drive_shares` (resource-scoped sharing).
- Upload: `POST /api/files/upload` (multipart, server encrypts before
  writing to `./uploads`).
- **Download is authenticated**: `GET /api/files/{id}/download` checks
  ownership or membership in `drive_shares` before streaming.
- No static serving of `/uploads` — defence in depth against link leaks.
- Folder tree validation: parent must exist and belong to the same user
  before nesting (prevents cross-user trees).

Files: [backend/src/drive/](backend/src/drive/) + frontend
[drive/](frontend/src/drive/).

### 7.5 Notes

- Single `notes` table, title + content encrypted at rest.
- `/api/notes` CRUD; `GET` / `POST` / `PUT` / `DELETE`.

Files: [backend/src/notes/](backend/src/notes/) + frontend
[notes/](frontend/src/notes/).

### 7.6 Tasks

- `tasks` table — `name`, `description`, `priority` (1-5), `status`
  (`in_progress`/`done`).
- Webhook fan-out: `task.created` / `.updated` / `.deleted`.

Files: [backend/src/tasks/handler.rs](backend/src/tasks/handler.rs) +
frontend [tasks/](frontend/src/tasks/).

### 7.7 AI Chat (Gemini)

- `POST /api/ai/chat` with `{ messages: [{role, content}, ...] }`.
- Maps to `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`.
- API key (`GEMINI_API_KEY`) lives server-side only — never exposed.
- No conversation history stored; the caller manages windowing.

Files: [backend/src/ai/](backend/src/ai/) + frontend
[aichat/](frontend/src/aichat/).

### 7.8 Calls (WebRTC)

- Signalling: WebSocket `/ws/call`, JWT-authenticated.
- Cross-scope calls rejected (`CallerScope` enum gates the signalling
  receive path, not just the contacts list).
- TURN: `GET /api/turn/credentials` proxies short-lived Cloudflare TURN
  credentials. Falls back to STUN-only with a 503 if Cloudflare creds
  aren't configured.
- ICE candidate JSON is `#[serde(rename_all = "camelCase")]` — important
  bug-class to remember, browsers send `sdpMid` / `sdpMLineIndex`.
- Permissions-Policy CSP header sets `camera=(self), microphone=(self)`
  so `getUserMedia` actually works in production iframes.

Files: [backend/src/call/](backend/src/call/) + frontend
[call/](frontend/src/call/).

### 7.9 Billing (Stripe + payroll)

- Schema: `plans` + `subscriptions` + `invoices` + `entitlements` +
  `billing_customers` + `usage_events`.
- Plans (seeded): `basic_user` (free), `advance_user` ($7/mo),
  `organization` ($10/seat/mo), `enterprise` (custom).
- Each plan now carries `rate_limit_per_min` + `monthly_quota` columns
  used by the API-key middleware (see §9.2).
- Self-service: `/billing` page handles Stripe Checkout, default payment
  method via SetupIntent, cancel/renew, organization seat usage.
- Platform billing console at `/platform/billing` aggregates revenue
  (MRR / ARR), per-tenant subscriptions, invoices, and payroll.
- Payroll: `employees` + `payroll_runs` + `payroll_run_items` tables.
  Monthly cost is normalised from `pay_frequency` (monthly/biweekly/
  weekly/annual). Tax rate is configurable per run.

Files: [backend/src/billing/](backend/src/billing/) + frontend
[billing/](frontend/src/billing/) and [platformBilling/](frontend/src/platformBilling/).

### 7.10 Outbound webhooks

- Customer-facing surface for subscribing to events.
- Catalog (frozen v1): `task.created/.updated/.deleted`,
  `meeting.created/.updated/.deleted`, `email.received`, `email.sent`,
  `chat.message.sent`, `chat.channel.created`, `wayve.ping`.
- Signed deliveries: `Wayve-Signature: t=<ts>,v1=<hmac>`,
  HMAC-SHA256 over `<ts>.<body>`.
- Retry policy: 3 attempts at 0s / 1m / 5m. Auto-disable endpoint after
  20 consecutive failures.
- Dispatcher claims work via `FOR UPDATE SKIP LOCKED` so multiple
  instances stay safe.
- Privacy: chat events are metadata-only (content is E2E encrypted);
  email events omit body (fetch via `/api/emails/{id}` if needed).
- Detailed contract in [documentation/README.md](documentation/README.md)
  + [backend/src/docs/price_tier.md](backend/src/docs/price_tier.md).

Files: [backend/src/webhooks/](backend/src/webhooks/) + frontend
[settings/Webhooks.tsx](frontend/src/settings/Webhooks.tsx).

---

## 8. Platform-team consoles

Different platform roles land on different home pages — see
[frontend/src/auth/accountHome.ts](frontend/src/auth/accountHome.ts):

| Role | Home URL | What's there |
| --- | --- | --- |
| owner / super_admin / admin | `/platform-admin-home` | Org provisioning + members + API keys + a "Platform consoles" card linking to all four below |
| billing | `/platform/billing` | Revenue (MRR/ARR), invoices, user + org subscriptions, employees + payroll runs |
| security | `/security/audit` | Audit log + bulk export buttons + SIEM webhook forwarder |
| developer | `/platform/developer` | API key stats, top-endpoint analytics, recent audit trail, webhook + SSO integration counts |
| support | `/platform/support` | Users / orgs / signups / shared-inbox queue |
| member / guest | `/platform/welcome` | Identity card + app tiles + "request more access" pointer |

Owner-only:
- `/platform/secrets` — mint + test API keys, mint embed tokens.

---

## 9. Developer surface

### 9.1 OpenAPI + Redoc portal

- Spec: `GET /api/openapi.json` (public, no auth). Hand-curated to expose
  only stable programmatic endpoints — admin/oauth routes are
  intentionally absent.
- Description body lives in [backend/src/openapi/description.md](backend/src/openapi/description.md);
  the binary embeds it via `include_str!()`.
- Portal: `/developers` (public) renders the spec with self-hosted Redoc
  (`/redoc.standalone.js` in `frontend/public/`, ~890 KB, no CDN needed).
- Tutorials inline on the page: send email, create task, schedule meeting,
  subscribe to webhooks, run AI prompt.

### 9.2 Rate-limit tiers & quotas

Public catalog at `/developers/quotas`:

| Tier | Plan code | Price | Rate | Monthly requests |
| --- | --- | --- | --- | --- |
| Free | `basic_user` | $0 | 60/min | 50,000 |
| Advance | `advance_user` | $7/mo | 300/min | 500,000 |
| Organization | `organization` | $10/seat/mo | 600/min | 5,000,000 |
| Enterprise | `enterprise` | custom | 6,000/min | Unlimited |

Enforcement:
- `MIN(api_key.rate_limit_per_min, plan.rate_limit_per_min)` per request.
- Monthly counter aggregated across **every** API key the user owns.
- Calendar-month reset at `00:00 UTC`, decoupled from Stripe billing
  anniversary.
- Redis-backed; fails open on Redis outage with audit-log breadcrumb.

Endpoints:
- `GET /api/billing/tiers` (public) — feeds the comparison page.
- `GET /api/billing/quota` (authenticated) — your tier + used + reset time.

### 9.3 Published documentation portal

- `/docs` lists allowlisted markdown docs, served from
  `backend/src/docs/handler.rs::CATALOG`.
- Current catalog: `price-tier` (this is the only doc published; everything
  in `documentation/` is internal scratchpad and explicitly NOT exposed).
- Renderer: self-hosted `marked@12` at `frontend/public/marked.min.js`.

---

## 10. Enterprise integrations

### 10.1 OIDC SSO (Wayve as relying party)

- Per-org configs in `org_sso_configs` (encrypted client secret).
- Email-domain routing via `allowed_domain`.
- PKCE + nonce in `sso_states` table; codes can't be replayed.
- Optional `enforce_sso=true` blocks password login for that org.

### 10.2 SCIM 2.0 (Wayve as service provider)

- Mounted at `/scim/v2/*` per RFC 7644.
- Discovery (no auth): `ServiceProviderConfig`, `Schemas`, `ResourceTypes`.
- Users CRUD (bearer auth): `GET /Users`, `GET /Users/{id}`, `POST /Users`,
  `PUT /Users/{id}`, `DELETE /Users/{id}` (soft → `guest`).
- Filter: `userName eq "x"` and `externalId eq "x"`. Anything else → 400.
- Token mint in dashboard at `/settings/scim` (gated on `webhooks:manage`).
- **Gaps in v1**: no Groups, no PATCH, no complex filters, no `/Bulk`.

### 10.3 Outbound webhooks

See §7.10.

### 10.4 Audit log export

- `GET /api/audit/export?format=jsonl|csv&since=<iso>&before_id=<n>&limit=<n>`.
- Response headers `X-Audit-Count` + `X-Audit-Next-Cursor` drive SIEM pull loops.
- Per-scope visibility: Platform sees all, Org sees its own org, Personal
  sees its own keys.
- Gated on `audit:read` permission. UI buttons on `/security/audit`.

### 10.5 Embed tokens

- `POST /api/embed/tokens` (session-JWT auth) → 5-min HS256 JWT with
  `iss=wayve-embed`, `aud=<origin>`, narrow read-only scopes.
- Sent as `X-EMBED-TOKEN`. Middleware enforces GET-only + origin pin.
- Allowed scope catalog (`/api/embed/scopes`, public discovery):
  `profile:read`, `email:read`, `chat:read`, `scheduler:read`, `drive:read`,
  `notes:read`, `tasks:read`.
- UI on `/platform/secrets` (owner-only).
- **Gap in v1**: no per-route scope enforcement (only GET method),
  no token revocation list (rotation = wait 5 min).

### 10.6 SIEM webhook forwarder

- Distinct from inbound webhooks: this pushes audit events **out** to a
  customer-supplied URL.
- Config at `/security/audit` (gated on `webhooks:manage`).
- Token stored encrypted (AES-GCM) in `siem_webhook_configs`.

---

## 11. Workers & background jobs

The backend container can run in four `RWAYVE_ROLE` modes
([backend/src/config.rs](backend/src/config.rs)):

| Role | What runs |
| --- | --- |
| `api` (default) | HTTP server + webhook dispatcher |
| `email_sync_worker` | Just the sync loop |
| `email_body_worker` | Just the body backfill |
| `all` | API + every worker (dev convenience) |

Workers:

| Worker | Cadence | What it does |
| --- | --- | --- |
| `sync_worker` | 30 s | Pulls new mail (Gmail/Outlook) for every connected account. Exponential backoff to 5 min on error. |
| `body_worker` | continuous | Fetches Gmail message bodies + attachments for `body_encrypted = ''` rows. |
| `billing::spawn_billing_worker` | 1 h | Deactivates entitlements whose subscriptions have lapsed. |
| `webhooks::spawn_dispatcher` | 5 s | Claims pending `webhook_deliveries` rows (`FOR UPDATE SKIP LOCKED`), POSTs signed bodies, retries with backoff. |

---

## 12. Build, dev, deploy

### 12.1 Local dev (Docker)

```bash
# Bring everything up
docker compose -p rwayve -f infra/docker-compose.yml up -d --build

# Seed RBAC test users (18 accounts; password Mahesh)
./scripts/seed_rbac_users.sh

# Tail backend logs
docker logs -f rwayve_backend_dev
```

URLs:

- `http://localhost/` — frontend via nginx
- `http://localhost:5173` and `http://localhost:3000` — Vite dev server
- `http://localhost:8080` — backend direct
- `http://localhost:8025` — Mailpit (part of the dev stack)
- `http://localhost:16686` — Jaeger UI

### 12.2 Without Docker

```bash
cd backend && cargo run
cd frontend && npm run dev
# (also needs Postgres + Redis running; see backend/.env.development)
```

### 12.3 Tests + lint

```bash
# Backend
cargo fmt
cargo clippy -- -D warnings
cargo test --no-fail-fast -- --test-threads=1   # CI runs single-threaded

# Frontend
npx tsc --noEmit
npm run lint
npm test
```

### 12.4 CI

[.github/workflows/smoke.yml](.github/workflows/smoke.yml) has three jobs:
- **backend-tests** (Postgres + Mailpit services, `init.sql` applied,
  single-threaded `cargo test`).
- **frontend-tests** (`tsc --noEmit` + `npm test`).
- **docker-smoke** (depends on the above; runs `scripts/smoke.sh` against a
  freshly-built compose stack).

### 12.5 Production deploy

- Target: EC2 `i-07af9db286562f5ac` (EIP `32.199.117.86`).
- DNS: `rwayve.maheshg.me`.
- Script: `scripts/deploy.sh` (ssh, pull, rebuild, force-recreate nginx).
- AWS profile: `claude_ec2`. SSH key: `~/.ssh/rwayve-deploy.pem`.

---

## 13. Schema reference (the 40 tables that matter)

| Table | Purpose |
| --- | --- |
| `users` | Identity. `account_type` = `personal | organization | organization_admin | platform_admin`. `recovery_mode` discriminates the wrapped-key flavour. |
| `organizations` | Tenant root. |
| `organization_members` / `platform_members` | RBAC role rows; nine-role CHECK constraint. |
| `password_reset_tokens` | One-hour TTL reset links. |
| `oauth_states` | CSRF-binding for Gmail / Outlook OAuth. |
| `org_sso_configs` / `sso_states` | OIDC RP configs (encrypted client_secret) + in-flight PKCE binding. |
| `email_accounts` | Connected mailboxes; `provider` ∈ `google/outlook`, `is_shared`, `provider_unread_count`. |
| `shared_inbox_members` / `shared_inbox_email_state` | Team-mailbox membership + per-message status (open/pending/closed). |
| `emails` | Synced headers; `body_encrypted=''` sentinel = "body worker, please fetch". `labels TEXT[]` is GIN-indexed. |
| `email_attachments` | Encrypted attachment store. |
| `meetings` / `meeting_participants` | Scheduler. Title + Zoom URL + participant emails encrypted. |
| `messages` | Chat DMs. `content_encrypted` is the E2E envelope wrapped in at-rest AES-GCM. |
| `channels` / `channel_members` / `channel_join_requests` / `channel_invites` / `channel_messages` | Channels surface. |
| `files` / `folders` / `drive_shares` | Drive. Authenticated download only. |
| `notes` | Encrypted notes. |
| `tasks` | Tasks (priority 1-5, status in_progress/done). |
| `billing_customers` / `plans` / `subscriptions` / `invoices` / `usage_events` / `entitlements` | Stripe projection + per-tenant entitlements. |
| `employees` / `payroll_runs` / `payroll_run_items` | Payroll. |
| `webhook_endpoints` / `webhook_deliveries` | Outbound event subscriptions + delivery queue. |
| `siem_webhook_configs` | Outbound audit forwarder (separate from #29). |
| `api_keys` / `api_key_audit_log` | Programmatic auth + per-request audit. |
| `scim_tokens` | SCIM bearer tokens (SHA-256 hashed). |
| `user_wrapped_keys` | Server-stored, PBKDF2-wrapped private keys for recovery. |

Source of truth: [infra/postgres/init.sql](infra/postgres/init.sql).
Self-healing ALTERs (applied on every backend boot):
[backend/src/startup.rs](backend/src/startup.rs).

---

## 14. Where to look in code

| Concern | File |
| --- | --- |
| Route table | [backend/src/main.rs::app_routes](backend/src/main.rs) |
| RBAC matrix | [backend/src/security/rbac.rs](backend/src/security/rbac.rs) |
| JWT mint/verify | [backend/src/security/jwt.rs](backend/src/security/jwt.rs) |
| API key middleware | [backend/src/middleware/api_key.rs](backend/src/middleware/api_key.rs) |
| API key scope catalog | [backend/src/security/api_key.rs::required_scope](backend/src/security/api_key.rs) |
| AES-GCM helpers | [backend/src/security/encryption.rs](backend/src/security/encryption.rs) |
| Rate-limit + quota enforcement | [backend/src/middleware/api_key.rs](backend/src/middleware/api_key.rs) + [backend/src/billing/quotas.rs](backend/src/billing/quotas.rs) |
| Webhook dispatcher | [backend/src/webhooks/dispatcher.rs](backend/src/webhooks/dispatcher.rs) |
| Webhook fan-out helper | [backend/src/webhooks/events.rs::emit](backend/src/webhooks/events.rs) |
| Embed-token middleware | [backend/src/embed/middleware.rs](backend/src/embed/middleware.rs) |
| SCIM service-provider | [backend/src/scim/handler.rs](backend/src/scim/handler.rs) |
| SCIM token store | [backend/src/scim/tokens.rs](backend/src/scim/tokens.rs) |
| OpenAPI source | [backend/src/openapi/handler.rs](backend/src/openapi/handler.rs) + [backend/src/openapi/description.md](backend/src/openapi/description.md) |
| Published docs catalog | [backend/src/docs/handler.rs](backend/src/docs/handler.rs) |
| Frontend routing | [frontend/src/App.tsx](frontend/src/App.tsx) |
| Per-role landing logic | [frontend/src/auth/accountHome.ts](frontend/src/auth/accountHome.ts) |
| Frontend permission catalog (mirror) | [frontend/src/auth/permissions.ts](frontend/src/auth/permissions.ts) |
| Chat E2E unwrap | [frontend/src/chat/e2ee.ts](frontend/src/chat/e2ee.ts) |
| Self-hosted Redoc bundle | [frontend/public/redoc.standalone.js](frontend/public/redoc.standalone.js) |
| Self-hosted marked bundle | [frontend/public/marked.min.js](frontend/public/marked.min.js) |

---

## 15. Known limitations & roadmap

Honest list of what's documented as a v1 simplification:

| Area | Limit | When to revisit |
| --- | --- | --- |
| SCIM | No Groups, no PATCH, no complex filters, no `/Bulk` | When a customer's IdP requires them |
| Embed tokens | No per-route scope enforcement (GET-only as proxy), no revocation list | If a partner wants narrower-than-all-reads tokens |
| Webhook dispatcher | Polls Postgres every 5 s; 25-row claim batch; max 10 k rows per audit export response | If a tenant pushes > a few thousand events / min sustained |
| Audit export | Buffers up to 10 k rows in memory | True chunked streaming with `sqlx::fetch` when a SIEM polls > 100 k rows |
| OAuth 2.0 authorization server | Not implemented — Wayve is only a relying party | When a 3rd-party app wants user-consented tokens |
| Per-customer rate-limit tiers | Static (60/300/600/6000) per plan | When a customer needs custom enterprise tiers |
| Chat E2E | RSA-2048 keys, no forward secrecy, no key ratcheting | A real chat-security audit |
| Backup / DR | No documented procedure beyond Postgres dumps | Before going past ~50 enterprise tenants |

---

## 16. Where to start a new feature

1. **Schema first.** Edit [infra/postgres/init.sql](infra/postgres/init.sql)
   *and* mirror the ALTERs in [backend/src/startup.rs](backend/src/startup.rs)
   so prod self-heals on next deploy.
2. **Backend module.** New dir under `backend/src/<feature>/` with `mod.rs`
   + `handler.rs`. Register routes in `main.rs::app_routes`. Use
   `AppResult` + `?` for error propagation.
3. **API contract.** If it's public, document it in
   [backend/src/openapi/handler.rs](backend/src/openapi/handler.rs).
4. **Frontend.** New dir under `frontend/src/<feature>/`. Lazy-import in
   `App.tsx` and add to `vite.config.ts::server.warmup.clientFiles` if it's
   a primary surface.
5. **Tests.** Backend tests are tricky — see CLAUDE.md "Backend tests"
   warning about the `src/tests/` directory not being wired into the
   compile unit by default.
6. **Lint gates.** `cargo clippy -- -D warnings` and `tsc --noEmit` are
   blocking — keep them green.
7. **Webhook fan-out.** If your feature has CRUD-shaped events, call
   `webhooks::emit(pool, owner, Event::X, payload)` from each producer.
   Add the event type to `Event::ALL` and document the payload shape in
   [backend/src/docs/price_tier.md](backend/src/docs/price_tier.md).

---

## 17. License & contact

- Commercial license; not OSS.
- Contact: support@rwayve.maheshg.me (operational), security@rwayve.maheshg.me
  (vulnerability disclosure).

---

*Last refreshed: 2026-05-24. API surface version: `2026.05`.
Where this doc disagrees with the code, the code is canonical.*
