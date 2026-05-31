# Wayve — Technical Deep Dive

Companion to [wayve.md](wayve.md). Where wayve.md gives the *what*, this
document gives the *how* — request lifecycles, threat models, data-flow
diagrams, performance characteristics, and the specific code paths every
claim corresponds to.

Two ground rules:

1. **The code is canonical.** Every section ends with a "files" pointer
   so a fact-check is one click away.
2. **Honest about limits.** Where the system has known v1 simplifications,
   they're called out inline — not buried in a footnote.

---

## 0. Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Process topology + runtime roles](#2-process-topology--runtime-roles)
3. [Request lifecycle — the auth chain](#3-request-lifecycle--the-auth-chain)
4. [RBAC: how a permission check actually runs](#4-rbac-how-a-permission-check-actually-runs)
5. [API key + rate-limit + quota enforcement](#5-api-key--rate-limit--quota-enforcement)
6. [WebSocket subsystems (chat + call)](#6-websocket-subsystems)
7. [Background workers](#7-background-workers)
8. [Email sync — the most complex feature](#8-email-sync--the-most-complex-feature)
9. [End-to-end chat encryption](#9-end-to-end-chat-encryption)
10. [Drive file storage + sharing](#10-drive-file-storage--sharing)
11. [Webhook delivery engineering](#11-webhook-delivery-engineering)
12. [Database schema deep dive](#12-database-schema-deep-dive)
13. [Caching strategy](#13-caching-strategy)
14. [Encryption architecture](#14-encryption-architecture)
15. [Threat model (STRIDE)](#15-threat-model)
16. [Performance + scaling characteristics](#16-performance--scaling-characteristics)
17. [Observability](#17-observability)
18. [Testing strategy](#18-testing-strategy)
19. [CI/CD pipeline](#19-cicd-pipeline)
20. [Schema evolution + migrations](#20-schema-evolution--migrations)
21. [Frontend architecture](#21-frontend-architecture)
22. [Build & dependency posture](#22-build--dependency-posture)
23. [Disaster recovery](#23-disaster-recovery)
24. [Known technical debt](#24-known-technical-debt)

---

## 1. Architecture overview

```
                          ┌──────────────────────────────────────────────┐
                          │              Internet                        │
                          └──────────────────────────────────────────────┘
                                              │
                                  HTTPS (Let's Encrypt)
                                              │
                          ┌──────────────────▼──────────────────────────┐
                          │  nginx 1.27        (EC2 i-07af9db286562f5ac) │
                          │  ─ TLS terminate                              │
                          │  ─ /api/* + /scim/v2/* + /ws/*  → backend     │
                          │  ─ everything else              → SPA bundle  │
                          │  ─ CSP, Permissions-Policy, HSTS              │
                          └────┬───────────────────────────┬──────────────┘
                               │                           │
              ┌───────────────▼─────────────┐   ┌─────────▼──────────────┐
              │  rwayve-backend:dev (Rust)   │   │   rwayve-frontend       │
              │  ─ Actix Web 4               │   │   (static SPA, Vite     │
              │  ─ 11 feature modules        │   │    build → /usr/share)  │
              │  ─ MimAlloc allocator        │   └─────────────────────────┘
              │  ─ tracing-actix-web         │
              │  ─ 4 runtime roles (env-sel) │
              └─┬──────┬──────┬──────┬──────┘
                │      │      │      │
                │      │      │      │
                ▼      ▼      ▼      ▼
            ┌──────┐ ┌─────┐ ┌──────┐ ┌──────┐
            │Postgres│Redis│Jaeger │Mailpit│   (dev only)
            │  15   │  7   │  1.60  │ v1.30 │
            └──────┘ └─────┘ └──────┘ └──────┘

        external dependencies (called by backend):
        ─ Gmail API (people-finder, send, sync)
        ─ Microsoft Graph (Outlook)
        ─ Google Generative Language (Gemini for /api/ai/chat)
        ─ Stripe (billing checkout + webhooks)
        ─ Zoom API (meeting creation, optional)
        ─ Google Calendar API (meeting export, optional)
        ─ Cloudflare Realtime (TURN credential proxy)
        ─ SMTP (transactional mail; Mailpit in dev)
```

### What is *not* in the topology

- No CDN in front of nginx (Cloudflare optional, not configured).
- No load balancer — single EC2 instance.
- No replica DB. No connection pooler (PgBouncer).
- No object store (S3) — Drive files sit on the EC2 volume in `./uploads`.
- No separate worker fleet — workers run inside the backend image, gated
  by `RWAYVE_ROLE`.

These are deliberate v1 scaling shortcuts. See §16 for when they bite.

---

## 2. Process topology + runtime roles

`backend/src/config.rs::RuntimeRole` is a four-way enum selected by the
`RWAYVE_ROLE` env var:

| Role | Spawned components | Container in dev |
| --- | --- | --- |
| `api` (default) | HTTP server + webhook dispatcher | `rwayve_backend_dev` |
| `email_sync_worker` | Just `email::sync::sync_all` loop | `rwayve_email_sync_worker_dev` |
| `email_body_worker` | Just `email::body_worker::run_body_worker` | `rwayve_email_body_worker_dev` |
| `all` | API + every worker (dev convenience) | not used in compose |

DB-pool sizing is role-dependent (see `db_max_connections`):
- API/All: **10** connections.
- Workers: **5** connections each.

**Why split workers?** The mail sync is bursty (30-second tick can pull
~50 messages × N accounts) and the body backfill is concurrency-bound (40
parallel Gmail fetches per account). Running them in the same process as
the HTTP server would either starve the API of pool slots during a sync,
or make the workers crawl when API traffic spikes. Splitting also lets
you scale the workers independently when one mailbox grows hot.

**Why does the webhook dispatcher run in `api`?** Because the cost is
near zero (5-second Postgres poll + 25-row claim batch) and it lets the
API container deliver events without depending on a separate worker
container being up. Multiple instances of the dispatcher are safe — the
claim uses `FOR UPDATE SKIP LOCKED`.

### Container boundaries (dev)

```
infra/docker-compose.dev.yml exposes:
   nginx          :80
   frontend       :3000 → :5173 (vite)
   backend        :8080
   email_sync     (no port)
   email_body     (no port)
   postgres_db    :5432
   redis          :6379
   mailpit        :8025 (UI), :1025 (SMTP)
   jaeger         :16686 (UI), :4317 (OTLP)

Volumes:
   postgres_dev_data       → /var/lib/postgresql/data
   ../uploads              → /app/uploads     (binds host)
   ../logs                 → /app/logs        (binds host)
   ../frontend             → /app             (binds host for HMR)
   /app/node_modules       (anonymous; preserves Linux build)
```

Files:
- [infra/docker-compose.dev.yml](infra/docker-compose.dev.yml)
- [backend/Dockerfile](backend/Dockerfile)
- [backend/src/main.rs](backend/src/main.rs)

---

## 3. Request lifecycle — the auth chain

Every Actix request flows through this middleware stack, in declared order
in `main.rs::HttpServer::new`:

```
   ┌───────────────────────────────────┐
   │  TracingLogger::default()         │  ← spans every request, exports OTLP
   ├───────────────────────────────────┤
   │  ApiKeyMiddleware                 │  ← if X-API-KEY: verify, scope, RL, inject principal
   ├───────────────────────────────────┤
   │  EmbedMiddleware                  │  ← if X-EMBED-TOKEN: verify, origin pin, GET-only
   ├───────────────────────────────────┤
   │  RateLimitMiddleware              │  ← global per-IP fallback
   ├───────────────────────────────────┤
   │  Cors                             │  ← single FRONTEND_URL allowlist
   ├───────────────────────────────────┤
   │  app_data: PgPool, Cache          │  ← shared handles
   ├───────────────────────────────────┤
   │  configure(app_routes)            │  ← register every #[get]/#[post]
   └───────────────────────────────────┘
```

The middlewares short-circuit cleanly:

- No `X-API-KEY` header → `ApiKeyMiddleware` is a no-op.
- No `X-EMBED-TOKEN` header → `EmbedMiddleware` is a no-op.
- Both gates are present only on `/api/*`. SCIM (`/scim/v2/*`) authenticates
  inside the handler with a bearer-token check, not via middleware.

### How `get_user_id_from_request` resolves identity

A single helper threads through every handler:

```rust
pub fn get_user_id_from_request(req: &HttpRequest) -> Option<i32> {
    // 1. API-key principal (stamped by ApiKeyMiddleware)
    if let Some(p) = req.extensions().get::<ApiKeyPrincipal>() {
        return Some(p.user_id);
    }
    // 2. Embed-token principal (stamped by EmbedMiddleware)
    if let Some(p) = req.extensions().get::<EmbedPrincipal>() {
        return Some(p.user_id);
    }
    // 3. JWT (Authorization: Bearer … OR cookie rwayve_auth)
    let token = token_from_request(req)?;
    let claims = decode_jwt(&token)?;
    Some(claims.sub)
}
```

This ordering matters: an API-key request will always carry an
`ApiKeyPrincipal` (the middleware inserted it after passing every check),
so the JWT path is never even attempted. WebSocket endpoints fall back
to a `?token=` query parameter to support browsers that can't set
arbitrary `Authorization` headers on WebSocket upgrades — the token is
still verified server-side, never trusted blindly.

Files:
- [backend/src/security/jwt.rs](backend/src/security/jwt.rs)
- [backend/src/middleware/api_key.rs](backend/src/middleware/api_key.rs)
- [backend/src/embed/middleware.rs](backend/src/embed/middleware.rs)

---

## 4. RBAC: how a permission check actually runs

```
Caller:                              Backend:
                                     ┌──────────────────────────┐
HTTP request                         │ #[post("/api/notes")]    │
  ─ Authorization: Bearer <jwt>      │   handler                │
                                     └────────┬─────────────────┘
                                              │
                                     get_user_id_from_request(req)
                                              │
                                              ▼
                                     rbac::require_permission(
                                       req, pool,
                                       Permission::NotesWrite,
                                     )
                                              │
                                              ▼
                                     resolve_role_context(pool, user_id)
                                              │
                                              ▼
                                     ┌─────────────────────────────┐
                                     │ SELECT u.account_type,      │
                                     │        u.organization_id,   │
                                     │        om.role  AS org_role,│
                                     │        pm.role  AS plat_role│
                                     │   FROM users u              │
                                     │   LEFT JOIN organization_members om
                                     │     ON om.organization_id = u.organization_id
                                     │    AND om.user_id = u.id    │
                                     │   LEFT JOIN platform_members pm
                                     │     ON pm.user_id = u.id    │
                                     │  WHERE u.id = $1            │
                                     └────────┬────────────────────┘
                                              │
                                              ▼
                                       Build RoleContext {
                                         scope, role, organization_id
                                       }
                                              │
                                              ▼
                                       role_has(role, perm) ?
                                              │
                                              ▼
                                     ┌──────────┴──────────┐
                                     │                     │
                                     ✓ pass               ✗ 403
                                     │
                                     ▼
                                     Handler runs with ctx
```

### Why per-request resolution?

Two reasons:

1. **Immediate effect** for role changes. If an org owner demotes a
   member from `admin` to `support` at T+0, the demoted user's next
   request at T+1 already sees the reduced permission set. No JWT
   refresh dance, no log-out flow.
2. **JWT integrity is not the same as permission integrity.** The JWT
   only proves "this is user X." The role is data, not capability.
   Trusting the JWT to also encode the role would mean a stale JWT
   minted under owner privileges still works after demotion — a
   real-world incident class we deliberately design out.

The cost is one extra Postgres query per privileged request. In practice:

- `users` is keyed on the primary key.
- The two LEFT JOINs are on indexed columns (`organization_members.user_id`,
  `platform_members.user_id`).
- The whole query is < 1 ms with default `shared_buffers`.

If this ever bottlenecks, the natural cache is per-user role context with
~60 s TTL in Redis — easy to add (mirror the moka cache pattern from
`email::account`). Not needed in v1.

Files:
- [backend/src/security/rbac.rs](backend/src/security/rbac.rs)

---

## 5. API key + rate-limit + quota enforcement

The most heavily-trafficked middleware in the app. Walk-through of the
flow per request:

```
Request arrives with X-API-KEY: wv_sk_…

1. Header present? → otherwise passthrough.
2. resolve_api_key(pool, raw_key)
     SELECT id, user_id, key_type, scopes,
            rate_limit_per_min, revoked_at, expires_at
       FROM api_keys
      WHERE key_hash = sha256_hex($1)
   ─ Not found → 401 invalid
   ─ revoked_at IS NOT NULL → 401 revoked
   ─ expires_at < NOW() → 401 expired
   ─ Stamp last_used_at (fire-and-forget tokio::spawn)
3. required_scope(method, path) → Option<&'static str>
   ─ Returns the scope this route demands, or None (unmapped → deny)
4. scope_satisfied(resolved.scopes, required) ?
   ─ Key has '*' OR includes the required scope literal → pass
   ─ Otherwise 403 denied_scope (audit logged)
5. Effective rate limit:
     plan_tier = quotas::effective_for_user(pool, resolved.user_id)
                 ─ 60s Moka cache on (user_id → plan tier)
                 ─ Cold-miss = one Postgres query
     effective = MIN(resolved.rate_limit_per_min,
                     plan_tier.rate_limit_per_min)
6. Per-key Redis counter:
     INCR  apikey_rl:{key_id}     (60s TTL)
   ─ count > effective → 429 (audit logged)
7. Per-user monthly quota (if plan.monthly_quota >= 0):
     INCR  apikey_quota:{user_id}:{YYYY-MM}    (32d TTL)
   ─ count > plan.monthly_quota → 429 (audit logged with reason)
8. Inject ApiKeyPrincipal { user_id, key_id, scopes }
   into request extensions.
9. Forward to handler.
10. After handler returns:
     audit:write(AuditEntry { api_key_id, user_id, method, path,
                              status_code, outcome, ip, created_at })
     ─ fire-and-forget (tokio::spawn)
```

### Why the MIN?

A platform owner can mint internal keys with `rate_limit_per_min: 6000`
and intend them for high-throughput services. But if the *user* that key
acts as is on the Free tier, the plan's `rate_limit_per_min = 60` still
applies. Issuing a key never relaxes the plan — it can only tighten.

### Why "fail open" on Redis outage?

The data API has an availability SLO; rate-limit enforcement does not.
If Redis is briefly unreachable, requests pass through with a `warn!` log
and a quota-relax audit-log entry. The alternative — failing closed —
would mean a Redis blip becomes a customer-visible outage, which is
worse than a few seconds of free-for-all on quota.

### Quota counter cadence

The monthly counter key is `apikey_quota:{user_id}:{YYYY-MM}` with a
**32-day TTL**. Why 32 days?

- A 31-day calendar month + 1-day grace handles month-boundary effects.
- The key for May is `apikey_quota:42:2026-05`. On June 1, that key
  becomes irrelevant and naturally expires 32 days after first INCR.
- The June key (`apikey_quota:42:2026-06`) starts fresh, independent of
  whether the May key has finished expiring.

### Failure modes worth knowing

| Scenario | Behaviour |
| --- | --- |
| Redis down at request time | Both counters fail open, audit log records the relax |
| Postgres down at audit-write | Audit entry lost (tokio::spawn, not blocked) |
| Postgres down at validate | Request blocked with 500; no key can be validated |
| Plan downgrade mid-month | Cache TTL up to 60 s before the new (lower) cap kicks in |
| Plan upgrade mid-month | Same — up to 60 s delay |
| Monthly quota exhausted | 429 with `Monthly request quota exceeded` until cycle reset |

Files:
- [backend/src/middleware/api_key.rs](backend/src/middleware/api_key.rs)
- [backend/src/security/api_key.rs](backend/src/security/api_key.rs)
- [backend/src/billing/quotas.rs](backend/src/billing/quotas.rs)

---

## 6. WebSocket subsystems

Two distinct WS surfaces with very different shapes.

### 6.1 Chat WebSocket (`/ws/chat`)

```
Client                                           Server
  │                                                │
  │  WS upgrade with Authorization: Bearer <jwt>   │
  │ ───────────────────────────────────────────► │
  │                                                │  authenticate
  │                                                │  register in SESSIONS
  │  ◄─────────────────────────────────────────── │  ack
  │                                                │
  │  {                                             │
  │    kind: "direct",                             │
  │    recipient_id: 5,                            │
  │    content: "WAYVE_CHAT_E2E_V1\n{...}"         │
  │  }                                             │
  │ ───────────────────────────────────────────► │
  │                                                │  ┌──────────────────┐
  │                                                │  │ validate envelope│
  │                                                │  │ prefix; refuse   │
  │                                                │  │ plaintext        │
  │                                                │  └──────────────────┘
  │                                                │  ┌──────────────────┐
  │                                                │  │ AES-GCM-wrap the │
  │                                                │  │ envelope for     │
  │                                                │  │ at-rest storage  │
  │                                                │  └──────────────────┘
  │                                                │  INSERT INTO messages
  │                                                │  RETURNING id, created_at
  │                                                │
  │                                                │  emit("chat.message.sent")
  │                                                │
  │  {message_id, sender_id, ..., status: "sent"} │
  │  ◄─────────────────────────────────────────── │  echo back to sender
  │                                                │
  │                              ┌────────────────────┐
  │                              │ recipient session  │
  │                              │ in SESSIONS map?   │
  │                              ├─yes─────────────┐  │
  │                              ▼                 │  │
  │                       forward msg              │  │
  │                              ▼                 │  │
  ◄──────────────────────────────── │              │  │
                                                   │  │
                                                   ▼  │
                                              if no session,
                                              recipient picks it up
                                              on next page reload
                                              via /api/messages?with_user_id
```

Two important properties:

1. **Same-scope only.** Cross-scope DMs are rejected at the receive
   handler, not just hidden in the contacts UI. Defence in depth — even
   if a malicious client crafts a payload with `recipient_id=999`, the
   handler refuses unless sender and recipient are in the same scope:
   - personal ↔ personal, OR
   - platform_admin ↔ platform_admin, OR
   - same `organization_id`.
2. **Storage is the envelope.** The DB never sees plaintext. The
   recipient's browser unwraps using IndexedDB-stored private key.

### 6.2 Call WebSocket (`/ws/call`)

```
ClientA                Server                  ClientB
  │   WS upgrade         │                       │
  │ ───────────────────► │ <RBAC resolve, scope> │
  │                      │                       │
  │ {kind:"call:invite", │                       │
  │  to: 5}              │                       │
  │ ───────────────────► │                       │
  │                      │   can_call_between(   │
  │                      │     A.scope, B.scope) │
  │                      │      ├── ok           │
  │                      │      └── reject (403) │
  │                      │                       │
  │                      │ ───────────────────► │  forward invite
  │                      │                       │
  │                      │  {kind:"offer",sdp:…}  │
  │                      │ ◄─────────────────── │
  │                      │ ◄───────────────────  │  (camelCase!)
  │ ◄───────────────────  │                       │
  │                      │                       │
  │ {kind:"answer",sdp:…}│                       │
  │ ───────────────────► │ ───────────────────► │
  │                      │                       │
  │ {kind:"ice",         │                       │
  │  candidate:…,        │                       │
  │  sdpMid:…,sdpMLineIx:…}                      │
  │ ───────────────────► │ ───────────────────► │
  │                      │                       │
                ┌─ ICE candidate exchange continues ─┐
                │ until p2p connection established   │
                └────────────────────────────────────┘
        Media flows direct A ↔ B (not through server).
        Cloudflare TURN used only if NAT traversal fails.
```

The `#[serde(rename_all = "camelCase")]` on `IceCandidate` is a real
historical bug-class to remember — browsers send `sdpMid` and
`sdpMLineIndex` in camelCase; rust default is snake_case, so without the
rename serde silently drops the fields and addIceCandidate fails with
"Candidate missing values for both sdpMid and sdpMLineIndex".

Files:
- [backend/src/chat/websocket.rs](backend/src/chat/websocket.rs)
- [backend/src/call/handler.rs](backend/src/call/handler.rs)
- [backend/src/call/turn.rs](backend/src/call/turn.rs)
- [backend/src/models/callmodel.rs](backend/src/models/callmodel.rs)

---

## 7. Background workers

### 7.1 Email sync worker

```
loop {
    sleep(SYNC_INTERVAL = 30s)
    accounts = load_syncable_email_accounts()   // ~10 ms

    for chunk in accounts.chunks(MAX_EMAIL_CONCURRENCY = 20) {
        for account in chunk {
            tokio::spawn(sync_one_account(account))
        }
        await all spawned tasks
    }
}
```

Per-account flow:

```
sync_one_account(account) {
    // 1. Refresh access token if expired (Gmail uses refresh_token)
    token = refresh_and_persist_email_token(account)

    // 2. Pull message IDs newer than last_sync
    ids = fetch_message_ids(account, after: last_sync)

    // 3. For each unknown id, fetch headers only (format=metadata)
    headers = ids
              .iter()
              .map(|id| fetch_headers_only(token, id))
              .buffer_unordered(20)
              .collect()

    // 4. Bulk INSERT … ON CONFLICT (account_id, gmail_id) DO UPDATE
    process_batch(pool, account.id, headers)
        // RETURNING (xmax = 0) → emit email.received only on real INSERTs

    // 5. Refresh provider unread count (Gmail labels.get / Outlook unreadItemCount)
    refresh_provider_unread_count(account)

    // 6. Side-pull SPAM and DRAFTs separately (Gmail labelIds=SPAM)
    sync_account_label_recent(account, "SPAM", cap=50)
    sync_account_label_recent(account, "DRAFT", cap=25)

    // 7. Update last_sync = NOW()
}
```

On error: exponential backoff up to 5 min (the loop catches the error and
sleeps double-time on each subsequent failure, capped).

### 7.2 Email body worker

The sync worker leaves bodies blank (`body_encrypted = ''`) for speed.
The body worker fills them in:

```
loop {
    sleep(BODY_POLL = 5s when idle, immediate when work pending)

    rows = SELECT id, account_id, gmail_id
             FROM emails
            WHERE body_encrypted = ''
               OR body_encrypted IS NULL
               OR attachments_checked = false
            ORDER BY account_id, id
            LIMIT 200_per_account

    // Index used: idx_emails_pending_body (partial)

    for chunk in rows.group_by(account_id) {
        // 40 concurrent fetches per account
        chunk
          .iter()
          .map(|email| fetch_and_persist_body(email))
          .buffer_unordered(40)
          .collect()
    }
}
```

Per-email:

```
fetch_and_persist_body(email) {
    token = refresh_token(email.account_id)
    raw = gmail_messages_get(token, email.gmail_id, format=full)
    body, attachments = extract_body_and_attachments(raw)

    encrypt(body) → (iv, ciphertext)
    UPDATE emails
       SET body_encrypted = ciphertext,
           body_iv = iv,
           has_body = true,
           updated_at = NOW()
     WHERE id = $1

    save_email_attachments(attachments)
    mark_attachments_checked(email.id)
        // separate UPDATE so a failure in save_email_attachments
        // doesn't poison the body_encrypted state
}
```

### 7.3 Billing reconciler

Once per hour:

```
UPDATE entitlements e
   SET active = false, updated_at = NOW()
 WHERE e.active = true
   AND NOT EXISTS (
       SELECT 1 FROM subscriptions s
        WHERE s.status IN ('active', 'trialing')
          AND ((e.user_id IS NOT NULL AND s.user_id = e.user_id)
            OR (e.organization_id IS NOT NULL
                AND s.organization_id = e.organization_id))
   )
```

This catches Stripe cancellation webhook deliveries we missed. Idempotent.

### 7.4 Webhook dispatcher

Covered in §11.

Files:
- [backend/src/workers.rs](backend/src/workers.rs)
- [backend/src/email/sync.rs](backend/src/email/sync.rs)
- [backend/src/email/body_worker.rs](backend/src/email/body_worker.rs)
- [backend/src/billing/mod.rs::spawn_billing_worker](backend/src/billing/mod.rs)

---

## 8. Email sync — the most complex feature

Sync is where the system's hardest constraints converge:

- Multi-tenant (per-user mailboxes, no cross-leak).
- Per-provider (Gmail + Outlook with different APIs and rate limits).
- Encrypted at rest.
- Subscribed via outbound webhooks (`email.received`).
- Cached aggressively (provider unread count, account metadata).
- Throughput-sensitive (~30 events / minute / active mailbox).

### Throughput math

- Sync tick: 30 s.
- Concurrency: up to 20 accounts in flight.
- Per-account fetch: up to 200 headers (rate limited by Gmail's 250
  quota units / sec — `messages.list` = 5 units, so safe).
- Body backfill: 40 concurrent / account, 200 / iteration.

Practical ceilings on a single backend instance:
- ~20 accounts × ~50 new msgs / 30 s = 1000 msgs / 30 s = ~33 msgs / s
  inbound + corresponding INSERT rows.
- Body worker: 200 / 40 × 5s avg per Gmail body fetch ≈ 25 messages / s
  body-decrypt-and-store throughput.

If a tenant blows past this, the natural scaling step is to shard accounts
across multiple `email_sync_worker` containers (the `last_sync` cursor is
per-account; nothing prevents parallel workers as long as they pick disjoint
account sets).

### Idempotency

Every insert uses `ON CONFLICT (account_id, gmail_id) DO UPDATE`. Re-running
the sync on the same window is a no-op for unchanged rows and a touch-up for
changed labels/is_read.

The `xmax = 0` flag in the `RETURNING` clause distinguishes a true INSERT
(stays 0) from an ON CONFLICT UPDATE (gets stamped with xid). We use this
to fire `email.received` webhooks only on genuine new arrivals — without
this filter, every sync tick would re-fire events for the entire mailbox.

### Outlook gotchas

- `mailFolders/{drafts,junkemail}/messages` for SPAM and DRAFT (Gmail labels
  don't apply; we synthesise label strings).
- `categories TEXT[]` field is what Outlook calls "labels"; we map to our
  `labels` column.
- `importance=high` → we synthesise a `IMPORTANT` label so the Important
  sidebar entry works across providers.

Files:
- [backend/src/email/sync.rs](backend/src/email/sync.rs)
- [backend/src/email/outlook.rs](backend/src/email/outlook.rs)
- [backend/src/email/body_worker.rs](backend/src/email/body_worker.rs)
- [backend/src/email/account.rs](backend/src/email/account.rs)

---

## 9. End-to-end chat encryption

### Key material

Every account has an RSA-2048 keypair generated client-side at first
sign-in. The public key is uploaded via `POST /api/save-public-key` and
indexed in the `users` row. The private key lives in browser IndexedDB
and is **never** sent to the server.

For recovery, a copy of the private key wrapped under
`PBKDF2(mnemonic, salt)` is uploaded to `user_wrapped_keys`. The mnemonic
is shown to the user once at signup and never persisted server-side.

### Envelope format

When Alice sends "hi bob" to Bob:

```
1. Alice's browser generates a fresh 32-byte AES key K.
2. K is AES-GCM-encrypted with a random 12-byte nonce → (iv_payload, ct_payload).
3. K is RSA-OAEP-encrypted with Bob's public key → wrapped_K_for_bob.
4. (If group chat, repeat 3 for every recipient.)
5. The envelope is serialized as:
     WAYVE_CHAT_E2E_V1\n
     {
       "wrapped_keys": {
         "5": "base64(wrapped_K_for_bob)",
         "7": "base64(wrapped_K_for_charlie)"
       },
       "iv": "base64(iv_payload)",
       "ct": "base64(ct_payload)"
     }
6. The whole string is sent as the `content` of the WS payload.
```

### Server-side

```
on_ws_message {
    if !content.starts_with("WAYVE_CHAT_E2E_V1\n") {
        // refuse — prevents accidental plaintext fallback
        return
    }
    // server cannot read the envelope
    let (iv, ciphertext) = encrypt_aes_gcm(content)   // at-rest layer
    INSERT INTO messages (..., content_iv, content_encrypted)
}
```

### Receive

```
on_ws_message_received (Bob's browser) {
    raw = decrypt_aes_gcm(content_iv, content_encrypted)
    // raw is now the envelope
    envelope = JSON.parse(raw.slice("WAYVE_CHAT_E2E_V1\n".length))
    wrapped_K = envelope.wrapped_keys["5"]   // Bob's user_id
    K = await crypto.subtle.decrypt({name: "RSA-OAEP"}, privateKey, wrapped_K)
    plaintext = AES_GCM_decrypt(K, envelope.iv, envelope.ct)
    render(plaintext)
}
```

### Why both layers?

- The envelope handles **end-to-end** secrecy — server never sees plaintext.
- The at-rest AES-GCM handles **storage** secrecy — if the DB dump ever
  leaks, you have to crack `AES_KEY` *and* every user's RSA key to read
  history.

### Known cryptographic gaps for v1

- **No forward secrecy.** RSA wrap means a future compromise of Bob's
  private key reveals all past messages.
- **No double ratchet.** Per-message AES key but no chain key derivation.
- **No key rotation.** Manual.
- **RSA-2048**, not Curve25519 / X25519.

If chat security is on the line, this needs a proper Signal-style
ratcheting protocol — out of scope for v1.

Files:
- [backend/src/chat/websocket.rs](backend/src/chat/websocket.rs)
- [frontend/src/chat/e2ee.ts](frontend/src/chat/e2ee.ts)
- [frontend/src/crypto/](frontend/src/crypto/)

---

## 10. Drive file storage + sharing

### Upload path

```
POST /api/files/upload  (multipart)
  ↓
JWT verify → user_id
  ↓
Resolve owner (personal vs org); load entitlement
  ↓
Check storage quota (entitlement.storage_limit_bytes vs SUM(files.size_bytes))
  ↓
encrypt_binary(body) → (iv, ciphertext)
  ↓
write ciphertext to ./uploads/<uuid>
  ↓
INSERT INTO files (user_id, folder_id, name, size_bytes,
                   content_type, file_iv, storage_path)
  ↓
record usage event (usage_events row)
  ↓
return { id, drive_url: "/api/files/{id}/download" }
```

### Download path

```
GET /api/files/{id}/download
  ↓
JWT verify → user_id
  ↓
Authorize: file.user_id == user_id
   OR file shared via drive_shares (matching scope + organization_id)
  ↓
read ciphertext from ./uploads/<storage_path>
  ↓
decrypt_binary(iv, ciphertext) → bytes
  ↓
stream as application/octet-stream
   (Content-Disposition: attachment; filename="name")
```

The deliberate choice not to static-serve `/uploads` is the key safety
property — even if a malicious user guesses the storage path, they can't
download without going through the ownership / share check.

### Sharing model

`drive_shares` is a polymorphic table:

```
drive_shares
─ resource_type     'file' | 'folder'
─ resource_id       FK into files OR folders
─ scope             'organization' | 'platform'
─ organization_id   nullable; required when scope='organization'
─ permission        'view' | 'edit'
─ created_by        FK users
```

When Bob's request for Alice's file lands:

```
SELECT 1
  FROM files f
  LEFT JOIN drive_shares s
    ON s.resource_type = 'file'
   AND s.resource_id = f.id
   AND (
       (s.scope = 'organization' AND s.organization_id = $bob_org_id)
    OR (s.scope = 'platform')
   )
 WHERE f.id = $file_id
   AND (f.user_id = $bob_id OR s.id IS NOT NULL)
```

Files:
- [backend/src/drive/handler.rs](backend/src/drive/handler.rs)
- [backend/src/drive/folders.rs](backend/src/drive/folders.rs)

---

## 11. Webhook delivery engineering

### Delivery state machine

```
                ┌──────────┐
                │ pending  │ ← INSERT by emit() or POST /test
                └────┬─────┘
                     │  dispatcher claims (FOR UPDATE SKIP LOCKED)
                     ▼
                ┌──────────┐
                │ in-flight│ (attempt_count incremented to N)
                └────┬─────┘
                     │
        ┌────────────┴────────────────┐
        │                             │
   2xx response                4xx (≠ 408/429) or 5xx or transport err
        │                             │
        ▼                             │
   ┌──────────┐                  ┌───┴───┐
   │delivered │                  │ N < 3?│
   └──────────┘                  └───┬───┘
                                     │
                              yes ───┼─── no
                                │    │
                                ▼    ▼
                       ┌──────────┐ ┌──────────┐
                       │ retry    │ │ failed   │
                       │ (next_at │ │ (or      │
                       │  =NOW+   │ │  abandoned
                       │  schedule[N-1])│ on 4xx) │
                       └──────────┘ └──────────┘
```

Retry schedule: `[1m, 5m]` after the immediate first attempt. With the
fail-state increment, that's 3 attempts total over ~6 minutes. After 20
consecutive failed deliveries on a single endpoint, the endpoint is
auto-disabled (its `enabled` flag flips false) and subsequent emit()
calls won't even insert delivery rows for it.

### Why 4xx ≠ 408/429 is fatal

A 4xx response (other than 408 timeout or 429 rate-limit) means the
receiver doesn't understand the payload — sending it again won't help.
Examples:
- 400: schema mismatch on the receiver
- 401: auth header missing on receiver-side firewall
- 410: endpoint deprecated by the customer

Marking these `abandoned` immediately keeps a misconfigured customer
from accumulating 1000s of pending retries.

### Signing

Stripe-style:

```
timestamp = unix_seconds_now()
sig = hex(HMAC_SHA256(secret, f"{timestamp}.{body}"))
header = f"t={timestamp},v1={sig}"
```

Why include the timestamp? **Replay defence.** A correctly-coded receiver
rejects anything more than ~5 minutes old. Without the timestamp, an
attacker who captured a valid delivery could re-fire it indefinitely.

### Idempotency keys

Every envelope carries `id: "evt_<uuid>"`. The receiver is expected to
dedupe on this id — Wayve makes no at-least-once vs exactly-once claim
beyond "we will not deliver an event twice unless retried after a
non-2xx", which means the receiver should treat dup deliveries as
benign no-ops keyed on `evt_id`.

### Throughput characteristics

- Dispatcher poll: 5 s.
- Claim batch: 25 rows.
- Effective ceiling: 25 × 12 = **300 deliveries / minute / dispatcher**.
- If demand exceeds that, the queue grows but no rows are lost — they
  just wait longer.

Scaling: spawn more `Api`-role containers. The `FOR UPDATE SKIP LOCKED`
makes the dispatchers cooperate naturally.

Files:
- [backend/src/webhooks/dispatcher.rs](backend/src/webhooks/dispatcher.rs)
- [backend/src/webhooks/events.rs](backend/src/webhooks/events.rs)

---

## 12. Database schema deep dive

Postgres 15. ~40 tables. Idiomatic patterns observed throughout:

### Idempotent migrations

Every DDL in `init.sql` uses `CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
Self-healing ALTERs are mirrored in `backend/src/startup.rs::ensure_email_schema`,
which runs on every backend boot. Net effect: the prod DB self-upgrades
on next deploy after a schema change.

This intentionally trades migration *files* (e.g. `sqlx migrate`) for
boot-time DDL. Trade-off: easier in early-stage; harder to reason about
once the schema has a few hundred ALTERs. Switch when count > 50.

### Encryption-pair columns

Every encrypted column comes in a pair:

```
title_encrypted   TEXT   -- base64 ciphertext
title_iv          TEXT   -- base64 nonce
```

This pattern repeats across `messages`, `emails`, `notes`, `meetings`,
`meeting_participants`, `files`. Decrypting is always
`decrypt(iv, ciphertext)`.

### Partial indexes

A handful of indexes are partial for huge wins:

```sql
CREATE INDEX idx_emails_pending_body
    ON emails (account_id, id)
 WHERE body_encrypted = '' OR body_encrypted IS NULL
    OR attachments_checked = false;

CREATE UNIQUE INDEX subscriptions_active_user_uniq
    ON subscriptions (user_id)
 WHERE status = 'active' AND user_id IS NOT NULL;

CREATE INDEX webhook_deliveries_pending_idx
    ON webhook_deliveries (next_attempt_at)
 WHERE status = 'pending';
```

The first one means the body worker's claim query is index-only even on a
mailbox of 50 k messages. The second prevents Stripe webhook races from
inserting duplicate active subs. The third makes the dispatcher's
`status = 'pending' AND next_attempt_at <= NOW()` lookup tiny regardless
of how much delivery history accumulates.

### GIN array indexes

```sql
CREATE INDEX idx_emails_labels ON emails USING GIN (labels);
```

`emails.labels TEXT[]` is the unified label store (Gmail labelIds +
Outlook categories + synthetic IMPORTANT for Outlook importance=high).
The GIN index makes `WHERE 'IMPORTANT' = ANY(labels)` index-scanned, so
the Important sidebar query is O(matches) not O(mailbox).

### Polymorphic tables (sparingly)

`drive_shares` and `siem_webhook_configs` use the discriminator pattern:

```
drive_shares.resource_type  ∈ {'file', 'folder'}
drive_shares.resource_id    INT (FK into one of two tables, by type)

siem_webhook_configs.scope        ∈ {'platform', 'organization', 'personal'}
siem_webhook_configs.organization_id  nullable; required when scope='organization'
```

This is OK at the scale here. The honest alternative — separate
`file_shares` + `folder_shares` tables — was rejected because the query
patterns are identical and `UNION ALL` joins would proliferate.

### FK cascade strategy

`ON DELETE CASCADE` is the default for tenant-owned data:

```
emails.account_id → email_accounts(id) ON DELETE CASCADE
email_accounts.user_id → users(id) ON DELETE CASCADE
organization_members.user_id → users(id) ON DELETE CASCADE
```

`ON DELETE SET NULL` for cross-tenant references that should survive
deletion (e.g. `payroll_runs.created_by`, `api_keys.created_by`).

`ON DELETE RESTRICT` only on `payroll_run_items.employee_id` — we don't
want to lose payroll history when an employee is deleted; the customer
must mark them `terminated` instead.

### Cascade implications

A `DELETE FROM users WHERE id = 42` will cascade into:

```
─ organization_members (membership)
─ platform_members
─ email_accounts → cascade to emails → cascade to email_attachments
─ shared_inbox_members
─ messages (sender_id, receiver_id)
─ channel_members + channel_messages (sender_id)
─ meetings (user_id) → cascade to meeting_participants
─ files → cascade to drive_shares (via resource_id polymorphism, manual)
─ folders → cascade to nested folders
─ notes
─ tasks
─ password_reset_tokens
─ user_wrapped_keys
─ webhook_endpoints → cascade to webhook_deliveries
─ siem_webhook_configs (user_id scoped)
─ api_keys (created_by SET NULL; user_id CASCADE since the key acts as them)
─ entitlements (user_id)
─ subscriptions (user_id; SET NULL on plan_id)
─ billing_customers (user_id)
─ employees (user_id SET NULL — employee row survives, just unlinked)
─ payroll_runs (created_by SET NULL)
```

This is fine for "delete account forever" workflows. It is **not** fine
for accidental DBA-level deletes — which is why nothing in the app
exposes a "DELETE FROM users" path; the highest you can go is "set
account_type = 'guest'" (SCIM soft-delete) or the platform admin's
`DELETE /api/admin/users/{id}` which is permission-gated.

---

## 13. Caching strategy

Two cache layers, distinct purposes:

### 13.1 Redis (`backend/src/cache.rs`)

For state that's shared across instances and needs atomic increments:

| Key pattern | TTL | Purpose |
| --- | --- | --- |
| `apikey_rl:{key_id}` | 60 s | Per-key requests/minute counter |
| `apikey_quota:{user_id}:{YYYY-MM}` | 32 d | Per-user monthly request counter |
| `profile:{user_id}` | 5 min | `/api/me` payload |
| `webhook_endpoint:{id}` | (not cached — fresh per delivery; customer changes are real-time) | — |

`increment_with_ttl` uses `INCR` + `EXPIRE` only on the first increment.
This is the standard pattern; the implementation is tiny.

### 13.2 Moka in-memory (per-process)

For data where staleness up to a minute is OK:

| Cache | TTL | Capacity | What |
| --- | --- | --- | --- |
| `EMAIL_ACCOUNT_CACHE` | 60 s | 10 k | Per-account row lookup |
| `USER_ACCOUNT_LIST_CACHE` | 60 s | 10 k | Per-user list of mailboxes |
| `EFFECTIVE_QUOTA_CACHE` | 60 s | 50 k | Per-user resolved plan tier |
| Various profile caches | varies | — | `/api/me`, role contexts |

The 60-second TTL is intentional. It bounds the worst-case staleness
when a customer upgrades their plan or revokes a permission. A shorter
TTL means more DB queries; a longer TTL means worse user experience on
mutation. 60 s is the sweet spot at our scale.

### Cache invalidation

The pattern across the codebase is **explicit invalidation on write**:

```rust
upsert_connected_email_account(...) -> Result<i32> {
    sqlx::query(INSERT … ).execute(...)?;
    invalidate_email_account_cache(account_id).await;
    invalidate_user_account_list_cache(user_id).await;
}
```

Reads pay nothing. Writes pay one extra cache `.invalidate()` per
affected key. Net effect: cache stays correct without TTL coordination.

---

## 14. Encryption architecture

### Layered model

```
        Plaintext
            │
            │  (1) Application-level encryption (the only layer Wayve owns)
            ▼
        Ciphertext + IV
            │
            │  (2) Postgres column storage
            ▼
        Block storage (EC2 EBS, GP3)
            │
            │  (3) AWS EBS encryption-at-rest (separate KMS key, AWS-managed)
            ▼
        Disk
```

We only own layer 1. Layer 2 is Postgres handling text fields. Layer 3
is AWS EBS doing its thing under the hood. The point: **even if disk is
seized**, the ciphertext is useless without `AES_KEY`.

### Key flow

```
.env.secrets
   AES_KEY=<64 hex chars>           ← input key material (IKM)
   AES_HKDF_SALT=<arbitrary string> ← salt (optional but should be stable)
        │
        │   parse Hex64 → 32 bytes IKM
        ▼
   HKDF-SHA512(IKM, salt) → 32-byte AES-256 key
        │
        ▼
   In-process Lazy<AesKey> (cached per process)
        │
        ▼
   encrypt(plaintext):
     nonce = random 12 bytes
     ciphertext_with_tag = AES_GCM_encrypt(key, nonce, plaintext)
     return (b64(nonce), b64(ciphertext_with_tag))
```

### Legacy decryption fallback

```
decrypt(b64_nonce, b64_ciphertext):
    try AES_GCM_decrypt(hkdf_derived_key, nonce, ciphertext)
    on AEAD failure:
        try AES_GCM_decrypt(raw_aes_key, nonce, ciphertext)
            // pre-HKDF rows
```

This lets us roll out HKDF derivation without re-encrypting everything.
**Note:** rotating `AES_HKDF_SALT` makes every existing row undecryptable
because the derived key changes. Don't rotate it; rotate `AES_KEY`
(rare) by re-encrypting in a maintenance window.

### Recovery seed

```
At signup:
    mnemonic = generate_24_word_bip39()
    user.private_key = generate_RSA_2048()
    pbkdf2_key = PBKDF2(mnemonic, salt=user.id, iters=200_000)
    wrapped = AES_GCM_encrypt(pbkdf2_key, nonce, user.private_key)
    POST /api/recovery/wrap { wrapped, iv, pub_key }
    show mnemonic to user EXACTLY ONCE; never persist server-side

On new device:
    mnemonic = user types it
    GET /api/recovery/wrap → { wrapped, iv, pub_key }
    pbkdf2_key = PBKDF2(mnemonic, salt=user.id, iters=200_000)
    private_key = AES_GCM_decrypt(pbkdf2_key, iv, wrapped)
    save private_key into IndexedDB
    user can now read encrypted history on this device
```

The salt being `user.id` is important — without per-user salting, an
offline mnemonic-cracking attack against one user would crack all users
who shared the same mnemonic-derived key (assuming PBKDF2 with no salt).

Files:
- [backend/src/security/encryption.rs](backend/src/security/encryption.rs)
- [backend/src/routes/recovery.rs](backend/src/routes/recovery.rs)
- [frontend/src/crypto/recovery.ts](frontend/src/crypto/recovery.ts)

---

## 15. Threat model

STRIDE-style. Per-feature, not per-asset.

### S — Spoofing

| Attack | Mitigation |
| --- | --- |
| Replay a captured JWT after logout | 24 h TTL; no refresh token. Bigger issue: we don't track JWT `jti` blocklist — if a JWT leaks, it's valid for up to 24 h. Mitigation: token is HttpOnly cookie + Authorization header pattern. v2: add `jti` revocation list keyed in Redis. |
| Replay a captured API key | Hash-only storage (SHA-256); raw never logged. Revocation immediate (next request after revoke gets 401). |
| Replay a webhook | Wayve-Signature has timestamp; receiver must reject > 5 min old. |
| Replay an embed token | 5-minute TTL + origin pin. The `aud=<origin>` claim is HMAC-bound. |
| Replay an SSO `code` | PKCE verifier bound to `sso_states` row; row deleted after use. |
| OAuth `state` mismatch | OAuth state generated server-side, stored in `oauth_states`, compared on callback. |

### T — Tampering

| Attack | Mitigation |
| --- | --- |
| Modify request body in transit | HTTPS via Let's Encrypt cert. nginx `add_header Strict-Transport-Security`. |
| Modify webhook payload | HMAC-SHA256 over `{timestamp}.{body}` with secret. |
| Modify JWT claims | HS256 signature; unknown secret → token invalid. |
| Forge SCIM token | SHA-256 hash-only storage; raw value not in DB. |
| Alter Stripe webhook | Stripe-signature header verified against `STRIPE_WEBHOOK_SECRET`. |

### R — Repudiation

| Asset | Audit trail |
| --- | --- |
| API key request | `api_key_audit_log` (method, path, status, outcome, IP, timestamp) |
| Webhook deliveries | `webhook_deliveries` (attempt_count, status, http_status, response_excerpt) |
| SCIM provisioning | `scim_tokens.last_used_at` stamped; create/delete go through `api_key_audit_log` via X-API-KEY surface if applicable |
| Role changes | (audit gap) — role updates don't currently write a separate log row. v2: add `role_change_log`. |
| Member create/delete | (audit gap) — same. |
| Payroll runs | `payroll_runs.created_by`, `paid_at` stamped |
| Login | (audit gap) — `users.last_login_at` not tracked. v2: add. |

Honest list of audit gaps. Login + role-change events are the biggest
ones to close before a real SOC 2 audit.

### I — Information disclosure

| Surface | Mitigation |
| --- | --- |
| DB dump leak | AES-GCM at-rest on every PII field (chat content, email body, file content, note content, meeting title, participant email, OAuth refresh tokens). Even with the dump, attacker needs `AES_KEY` from `.env.secrets`. |
| Server-side log leak | Logs use `tracing` with `skip(pool, data)` annotations; no token bodies, no email content, no chat messages. |
| Side-channel via timing | bcrypt is constant-time. HMAC compare uses constant-time `hmac::Mac::verify`. AEAD tag verify is constant-time by spec. |
| URL leaks | OAuth `code` lives in URL for ~one HTTP exchange and then gets exchanged for a token + the state row is deleted. Webhook URLs only land in `webhook_endpoints.url` (no log entry). |
| User-controlled HTML | Markdown renderer (marked v12 in /docs) runs through a `stripUnsafe` regex pass before injection. Vue/React's default escaping handles the rest. |
| Static-served Drive | NOT static-served — every download goes through ownership check. |

### D — Denial of service

| Attack | Mitigation |
| --- | --- |
| API request flood | Per-key rate limit (60-6000/min by tier); per-user monthly quota; global RateLimitMiddleware per-IP fallback. |
| Webhook receiver flood | One delivery per event per endpoint. 3 retry attempts capped. Auto-disable after 20 consecutive failures. |
| Email sync flood | 30-second sync tick; ON CONFLICT idempotent; body worker capped at 200 rows / iteration. |
| Slowloris on uploads | Multipart upload streams to disk; no buffer-in-memory of full payload. |
| Logout flood | bcrypt CPU cost on logins (~100 ms each); no equivalent on logouts. |
| DB connection exhaustion | Pool max 10 (API), 5 (workers). |

### E — Elevation of privilege

| Attack | Mitigation |
| --- | --- |
| User edits JWT to claim platform_admin | JWT integrity (HS256) prevents tampering. Even if forged, `account_type` from JWT is overridden by `resolve_role_context` on every privileged request. |
| API key with `*` scope minted by non-owner | Frontend gates the form on `platform_admin` + owner; backend gates the mint endpoint on `api_keys:manage`. |
| Cross-org data leak via SCIM | Every SCIM query is scoped to the bearer's `organization_id`; cross-org filter values are 400'd. |
| Cross-tenant chat read | Tenant-isolation check on WS message receive. |
| Cross-tenant file read | Authenticated download + `drive_shares` check. |

---

## 16. Performance + scaling characteristics

### Observed at v1 dev scale

- ~50 ms p95 for `/api/me` (one Postgres + one Redis call)
- ~120 ms p95 for `/api/emails` (paginated, 75 rows, decrypted in handler)
- ~5 ms for `/api/openapi.json` (Lazy<Vec<u8>>, ETag fast-path)
- WS handshake: ~80 ms incl. RBAC lookup
- Webhook delivery: 1-2 s end-to-end (5 s claim poll + HTTP RTT)

### Bottlenecks ranked

1. **Single Postgres instance.** No replica. A query that takes 200 ms
   pegs both read+write throughput. Mitigation: query review; pgBouncer
   when sustained load > 100 q/s.
2. **Single EC2 backend.** No auto-scaling. Mitigation: containerize
   harder; move to ECS Fargate; front with an ALB.
3. **Webhook fan-out to many endpoints.** A single `email.received`
   event with 100 subscribers = 100 webhook_deliveries rows = ~20 s
   to drain at 5/sec. Mitigation: bump dispatcher batch size; partition
   `webhook_deliveries` table.
4. **Bcrypt on login.** ~100 ms CPU cost. Mitigation: rate-limit logins
   per IP; consider argon2id when migration cost is justifiable.
5. **Email sync at 20-concurrent ceiling.** Mitigation: shard accounts
   across multiple `email_sync_worker` containers.

### Scaling steps in order

| Step | Trigger | Cost | Effect |
| --- | --- | --- | --- |
| Move logs to CloudWatch | Disk fills weekly | <$10/mo | Removes EBS pressure |
| Move Drive uploads to S3 | EBS > 80% | ~$0.023/GB | Decouples storage from compute |
| Add Postgres read replica | Read q/s > 200 | ~$50/mo | Halves master load |
| Add pgBouncer | Connection > 100 | ~$30/mo (small EC2) | Multiplexes connections |
| Split workers to dedicated EC2 | Worker steal > 30% CPU | ~$30/mo | Worker isolation |
| Container fleet (ECS Fargate) | Single-EC2 saturated | ~$100-300/mo | Horizontal scale |

---

## 17. Observability

### Three layers

1. **`tracing` with `tracing-actix-web::TracingLogger`** — every request
   spans, every DB call is a child span (`sqlx::query!` macro adds them).
   Exported via OTLP gRPC to Jaeger in dev (port 4317).
2. **`observability::devlog`** — a custom `log::Log` impl that writes to
   `backend/logs/dev.log` with target-based filtering. Existing code
   targets: `auth`, `ws`, `worker`, `db`, `gmail`, `billing`, `webhook`,
   `embed`. Adding a new target is just a string in the macro.
3. **`api_key_audit_log`** — the request-level audit trail for any
   X-API-KEY-authenticated request. Useful both for security review and
   debugging customer integrations.

### What's missing

- **Metrics export.** No Prometheus endpoint, no statsd push. Could be
  added by wiring `metrics-exporter-prometheus` and a `/metrics` route.
- **Real APM.** Jaeger is dev-only; prod has no equivalent. A managed
  Honeycomb / Datadog setup would close the gap.
- **Front-end RUM.** No real-user-metrics collection. Vite builds source
  maps; an integration like Sentry would surface client-side errors.

### When prod has an incident

The hierarchy of evidence:

```
1. nginx access log (request landed)
   /var/log/nginx/access.log on EC2

2. backend dev.log (handler ran)
   /app/logs/dev.log via the ../logs:/app/logs bind

3. Postgres logs (query level)
   inside the postgres container

4. Browser DevTools / Network panel (client-side)
```

Files:
- [backend/src/observability/](backend/src/observability/)

---

## 18. Testing strategy

### Backend

```
backend/src/<feature>/handler.rs
  └── #[cfg(test)] mod tests { ... }    ← inline tests, compile clean

backend/src/tests/<feature>_test.rs
  └── #[cfg(test)] mod tests { ... }    ← stand-alone; NOT WIRED INTO COMPILATION
                                          (see CLAUDE.md warning)

backend/src/test_support.rs
  ├── test_pool() → PgPool against TEST_DATABASE_URL
  ├── insert_local_user(email, password) → user_id
  ├── insert_google_user(email) → user_id
  ├── jwt_for(user_id) → String
  └── random_email() → String
```

CI runs `cargo test --no-fail-fast -- --test-threads=1`. The
single-thread is non-negotiable: many tests use `serial_test::serial`
because they mutate `std::env` (for `external::gmail_api_base()` and
similar overrides used to point at a `wiremock` server).

### Frontend

```
frontend/src/test/<feature>.test.tsx
  └── vitest + @testing-library/react + jsdom
```

The `frontend/src/test/setup.ts` polyfills `localStorage`/`sessionStorage`
and sets a default `VITE_API_URL=http://test.local` so tests don't depend
on a real `.env`.

### E2E

```
e2e/  (Playwright)
  └── smoke + auth flows
```

Runs in `.github/workflows/e2e.yml`, gates production deploys.

### Smoke

`scripts/smoke.sh` brings up the full docker stack and hits a curated set
of endpoints. Run before every prod deploy locally too — it's the cheapest
"is everything still wired up" check.

---

## 19. CI/CD pipeline

[.github/workflows/smoke.yml](.github/workflows/smoke.yml) defines three
jobs:

```
                   ┌──────────────────┐
                   │  push / PR       │
                   └────────┬─────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             │
    ┌──────────────┐  ┌──────────────┐    │
    │backend-tests │  │frontend-tests│    │
    │              │  │              │    │
    │ Postgres svc │  │ Node 20      │    │
    │ Mailpit svc  │  │              │    │
    │ init.sql     │  │ tsc --noEmit │    │
    │ cargo test   │  │ npm test     │    │
    │ -t 1 thread  │  │              │    │
    └──────┬───────┘  └──────┬───────┘    │
           │                 │            │
           └─────────────────┘            │
                            │             │
                            ▼             ▼
                   ┌──────────────────┐  (failure → stop)
                   │  docker-smoke    │
                   │                  │
                   │ scripts/smoke.sh │
                   │ ─ compose up     │
                   │ ─ throwaway env  │
                   │ ─ hit endpoints  │
                   │ ─ tear down      │
                   └──────────────────┘
```

Deployment is **manual**:

```bash
ssh ec2-user@<EIP>
git pull
sudo systemctl stop wayve-stack
docker compose -p rwayve -f infra/docker-compose.prod.yml up -d --build
```

Wrapped in [scripts/deploy.sh](scripts/deploy.sh) with safety prompts.
The script force-recreates the nginx container every deploy because the
TLS / CSP template rendering happens at container start and stale
configs caused real incidents earlier.

---

## 20. Schema evolution + migrations

### The self-healing approach

Every schema change is:

1. Add the DDL to `infra/postgres/init.sql` (idempotent: `IF NOT EXISTS`).
2. Mirror the ALTERs in `backend/src/startup.rs::ensure_email_schema`.
3. On next backend boot, the ALTER runs against the running DB.

Properties:
- Zero coordination — same code that boots a fresh dev DB upgrades prod.
- Idempotent: re-running is a no-op.
- Order-sensitive: the statements run in the order they appear, so be
  careful with cross-table refs.

### When this breaks down

- **Adding a NOT NULL column without a default.** The ALTER fails on
  existing rows. Fix: add with a default, backfill, then optionally drop
  default. Mirror the same pattern in startup.rs.
- **Renaming columns.** No safe one-shot. The pattern is: add new column,
  dual-write from app code, backfill, drop old column — three deploys.
- **Renaming tables.** Hard. We don't do this in v1; if a name must
  change, create a new table, dual-write, drop the old one.
- **Reaching ~50 ALTERs.** The startup.rs file gets unwieldy. Time to
  switch to versioned migrations with `sqlx migrate` and stop the
  self-heal pattern.

### Down-migrations

There are none. Schema goes one direction (forward). To "undo," roll
back the binary and apply the inverse ALTER manually. v1 simplification;
mature migration tooling solves this with `migrate down`.

---

## 21. Frontend architecture

### Bundle layout

```
/app                     /   Vite output
├── assets/             /   hashed JS + CSS chunks
├── index.html
├── redoc.standalone.js /   /developers Redoc bundle (890 KB, lazy-loaded)
├── marked.min.js       /   /docs Markdown renderer (35 KB, lazy-loaded)
├── favicon.svg
├── icons.svg
└── tracing-dashboard.html
```

Bundle stats (Vite 5 production build):
- Main chunk: ~190 KB gzipped (React + Router + AuthContext + Layout)
- Per-route lazy chunks: 20-80 KB each
- Total transferred for the home page: ~280 KB gzipped

### React Compiler enabled

`vite.config.ts` includes `babel-plugin-react-compiler`. Net effect:
most components don't need manual `useMemo` / `useCallback` because the
compiler emits memoized props automatically. The handful of effects
that the compiler can't memoize still need manual handling — and the
ESLint rule `react-hooks/set-state-in-effect` catches the most common
footgun (which we work around with the `setTimeout(0)` pattern in
multiple pages).

### Routing

`react-router-dom` v7. The route table is in [App.tsx](frontend/src/App.tsx),
~50 routes split into:

- Public: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`,
  `/recover-with-mnemonic`, `/pricing`, `/enterprise`, `/support`,
  `/developers`, `/developers/quotas`, `/docs`, `/docs/:slug`.
- Protected (wrapped in `ProtectedRoute` + `Layout`): every product page
  + the platform consoles + settings.
- Fallback: `*` → redirect to account home if signed in else `/login`.

### Auth state

`AuthContext` (eagerly loaded, listed in vite-warmup) reads the JWT from
`localStorage` on boot, decodes its claims optimistically, then refreshes
via `/api/me`:

```
boot
  ↓
read token from localStorage
  ↓
decode claims → optimistic user object (account_type, id, email)
  ↓
defaultAccessForAccount(account_type) → optimistic scope + role + perms
  ↓
fetch /api/me
  ↓
overwrite user with server-resolved scope + role + permissions
  ↓
re-render with real RBAC state
```

Why the optimistic step? So the UI doesn't flash a login form for a
second after a hard refresh. If `/api/me` fails (token expired, etc.),
we clear the optimistic state and redirect to login.

### State management

Mostly React context + local component state. No Redux, no Zustand,
no Jotai. The deepest cross-tree shared state is `AuthContext`. Per-page
state stays inside `useState`/`useReducer` and component-scoped contexts.

### Tests in monorepo

`vitest.config.ts` reorders `resolve.extensions` so `.tsx`/`.ts` win
over the stale `.js` siblings checked into the tree (see CLAUDE.md
"Stale .js siblings" gotcha). Forgetting this would silently load
pre-transpiled output in tests, and tests would silently pass against
the wrong code.

---

## 22. Build & dependency posture

### Backend dependencies (selected highlights)

| Crate | Version | Why |
| --- | --- | --- |
| actix-web | 4 | HTTP framework |
| sqlx | 0.8 | Async Postgres, compile-time query checks via `query!` macro |
| serde | 1 | JSON serialization, request bodies |
| jsonwebtoken | 9 | HS256 JWT mint/verify |
| aes-gcm | 0.10 | At-rest encryption |
| hmac + sha2 | 0.12 + 0.10 | Webhook signing, SCIM token hashing |
| bcrypt | 0.15 | Password hashing |
| moka | 0.12 | In-process TTL cache |
| reqwest | 0.12 | Outbound HTTP (Gmail, Stripe, Cloudflare, Gemini) |
| tracing + tracing-actix-web | recent | Observability |
| mimalloc | 0.1 | Default allocator (smaller heap fragmentation than glibc) |

`clippy.toml` enforces:
- `disallowed-methods`: `Option::unwrap`, `Result::expect` (production code).
- `too-many-arguments-threshold = 5` (bundle args into structs above this).

A future-incompat warning lurks: `redis 0.25.4` uses code that will be
rejected by a future Rust release. Track a `redis 0.26+` upgrade before
that lands.

### Frontend dependencies (selected highlights)

| Package | Version | Why |
| --- | --- | --- |
| react / react-dom | 18 | UI |
| react-router-dom | 7 | Routing |
| typescript | 5 | Types |
| vite | 5 | Bundler |
| @vitejs/plugin-react | recent | React Compiler enabled |
| vitest | 4 | Testing |
| eslint | flat config | Lint |

No state-management library, no UI kit. Components are hand-rolled CSS.
This is intentional — at the current scale, a UI kit is more pain than
it pays for.

### Lockfile churn

Both `Cargo.lock` and `frontend/package-lock.json` are committed. Avoid
running `cargo update` / `npm update` casually; review the resulting
lock-diff like any other PR.

---

## 23. Disaster recovery

### Backup posture (v1: weak)

- Postgres: no scheduled automated backups currently. RPO is essentially
  the most recent manual `pg_dump`.
- Drive files in `./uploads`: no backup. RPO = 0 for that data.
- `.env.secrets`: stored in 1Password (operator-managed).
- Stripe webhooks: replayable from the Stripe dashboard.

### Procedure for "EC2 instance gone"

1. Provision a fresh EC2 from a known AMI (Amazon Linux 2023).
2. Install Docker + Compose.
3. Clone repo.
4. Restore `.env.secrets` from 1Password.
5. Restore Postgres from most recent dump (if any).
6. `docker compose -p rwayve -f infra/docker-compose.prod.yml up -d --build`.
7. Update DNS → new EIP.

Realistic RTO: 4-6 hours.

### Procedure for "Postgres data corrupted"

1. Stop backend so writes pause.
2. Snapshot the volume (in case we need to forensics it).
3. Restore from most recent `pg_dump`.
4. Resync external state (Stripe webhooks via Stripe dashboard;
   Gmail/Outlook sync naturally on next worker tick).
5. Restart backend.

### What we'd need for SOC 2 / GDPR-grade

- Daily automated Postgres backups to S3 with 30-day retention.
- Cross-region replica.
- Documented RPO ≤ 1 h, RTO ≤ 4 h.
- Quarterly DR drill on a parallel stack.

These are tracked but not in v1.

---

## 24. Known technical debt

Honest list, ordered by how badly they'd hurt at 100 enterprise customers:

| Debt | Pain | Fix |
| --- | --- | --- |
| Self-healing migrations file growing | Hard to audit history; future deploys risk silent failures | Switch to `sqlx migrate` with versioned files; freeze startup.rs |
| Single EC2 instance | One node = one SPOF | Container fleet (ECS Fargate) behind an ALB |
| Drive on local EBS | Backups, scaling, multi-region all hard | S3 with signed-URL gateway |
| `clippy.toml` allows some technical sins | Several `#[allow(clippy::too_many_arguments)]` and `#[allow(dead_code)]` annotations | Refactor each into proper builder/parameter structs |
| Audit log for sensitive ops missing | login + role change + member CRUD not captured | Add `audit_events` table + wire from each producer |
| No OAuth 2.0 authorization server | Can't do "Sign in with Wayve" for 3rd party apps | Multi-week project; defer until concrete partner ask |
| RSA-2048 + no forward secrecy in chat | Signal-grade auditors would balk | Adopt libsignal or similar |
| No connection pooler | Postgres connections per-backend × instances grow fast | PgBouncer |
| No metrics → no real SLOs | "Is it slow?" is a gut check | Prometheus + Grafana |
| Test fixture sprawl | `backend/src/tests/*.rs` not wired into compile (CLAUDE.md warning) | Either delete or wire properly |
| No localstack equivalent for AWS | Drive doesn't really use AWS but Stripe webhooks make local testing tricky | Stripe CLI's `--forward-to` is the existing workaround |

---

*Last refreshed: 2026-05-24. API surface version: `2026.05`.
Cross-reference: [wayve.md](wayve.md) for the overview, [business_wayve.md](business_wayve.md) for the commercial picture.*
