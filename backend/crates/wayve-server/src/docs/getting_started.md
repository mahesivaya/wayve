# Getting started with Wayve

Welcome to Wayve — one workspace for **email, chat, calls, scheduling,
drive, notes, tasks, and an AI assistant**, with a scoped, audited API on
top of all of it. This guide is the fastest path from a new account to a
working integration. If you only read one page, read this one.

---

## 1. What's in the box

Wayve bundles eight product surfaces. Each has its own page in the app and
its own slice of the API:

| Surface | What it does | Concept doc |
| --- | --- | --- |
| **Mail** | Connect Gmail / Outlook, sync, read and send. Bodies are encrypted at rest. | [/docs/services/mail](/docs/services/mail) |
| **Chat** | Real-time DMs and channels with end-to-end encrypted envelopes. | [/docs/services/chat](/docs/services/chat) |
| **Meet** | Audio / video calls over WebRTC. | [/docs/services/meet](/docs/services/meet) |
| **Calendar** | Meetings, invites, Google Calendar / Zoom links. | [/docs/services/calendar](/docs/services/calendar) |
| **Drive** | File upload, sharing, per-file encrypted envelopes. | [/docs/services/drive](/docs/services/drive) |
| **Notes** | Personal notes synced across devices. | [/docs/services/notes](/docs/services/notes) |
| **Tasks** | To-dos with priority, status, and assignee. | [/docs/services/tasks](/docs/services/tasks) |
| **AI** | An assistant that can act over your mail, tasks, and more. | [/docs/services/ai](/docs/services/ai) |

---

## 2. Accounts & roles

Wayve has three account scopes:

- **Personal** — an individual workspace.
- **Organization** — a company tenant (the *Business* and *Enterprise*
  plans). Members share channels, scheduling, and billing.
- **Platform** — Wayve staff who administer the platform itself.

Inside an organization or the platform, your **role** decides what you can
do. The nine roles are `owner`, `super_admin`, `admin`, `security`,
`billing`, `developer`, `support`, `member`, and `guest`. Authorization is
computed from the database on **every request**, so a role change takes
effect immediately — it is never trusted from a stale token.

A few role-gated surfaces worth knowing:

- **Pricing** is visible only to `owner`, `super_admin`, and `billing`.
- **Code** (the repository view) is available to platform staff,
  organization owners, and `developer`s.
- **API key management** requires the `api_keys:manage` permission.

---

## 3. First steps as a user

1. **Register or sign in.** New signups are end-to-end encrypted — you'll be
   shown a 24-word recovery phrase exactly once. Store it safely: lose both
   your password and the phrase and the account is unrecoverable by design.
2. **Connect a mailbox** from the Emails page (Gmail or Outlook OAuth). Mail
   syncs automatically every ~30 seconds.
3. **Explore the surfaces** from the left sidebar — Chat, Scheduler, Drive,
   Notes, Tasks, and AI Chat all work out of the box.
4. **Invite your team** (organization owners) and assign roles from the
   members admin.

---

## 4. First steps as a developer

The API authenticates with an `X-API-KEY` header. A key acts **as a
specific user**, limited to the scopes, rate limit, and expiry stamped on it
at creation. Every call is recorded in an append-only audit log.

### Mint a key

Create a key from the API Keys page (or, for platform staff,
*Create secrets*). Choose the **narrowest** scope set your integration
needs, set an expiry, and copy the raw value — it is shown only once. Only
its SHA-256 hash is stored.

### Verify it works

```text
curl https://fluxze.com/api/me -H "X-API-KEY: wv_sk_..."

# 200 → identity        401 → bad key
# 403 → wrong scope     429 → rate-limited (retry with backoff)
```

### Scopes in one glance

Scopes come in read / write / realtime / privileged groups, e.g.
`email:read`, `email:send`, `chat:read`, `chat:write`, `scheduler:read`,
`scheduler:write`, `drive:read`, `drive:write`, `notes:read`, `notes:write`,
`tasks:read`, `tasks:write`, `ai:use`, `call:access`, and the privileged
`admin` / `*` (internal keys only). A request to a route your key doesn't
cover returns `403` — it never falls back to a wider permission.

For the **exact** request/response of every endpoint, use the interactive
reference — you can paste your key once and fire live requests:

- **Interactive API reference (Swagger):** [/docs/api](/docs/api)
- **Worked tutorials** (send email, create task, schedule a meeting,
  subscribe to webhooks, run an AI prompt): [/docs/developers](/docs/developers)
- **Download the OpenAPI 3.1 spec:** `/api/openapi.json`

---

## 5. Webhooks

Subscribe an HTTPS endpoint to events such as `task.created` and
`meeting.created`. The subscription response returns a signing secret
exactly once. Verify each delivery by recomputing the HMAC over
`{timestamp}.{raw-body}` and comparing it (in constant time) to the
`Wayve-Signature` header. The full event catalog and payload shapes are in
[Price Tiers & Event Producers](/docs/price-tier); a copy-pasteable
receiver lives in the [developer tutorials](/docs/developers).

---

## 6. Plans, quotas & rate limits

Four tiers — **Free**, **Advance**, **Organization**, **Enterprise** — each
with a per-minute cap and a monthly request budget. The effective cap is
`MIN(key limit, plan limit)`, and the monthly counter aggregates across all
of a user's keys. Full numbers, reset semantics, and fail-open behavior:

- **Plans & limits:** [/docs/quotas](/docs/quotas)
- **Tier + event reference:** [/docs/price-tier](/docs/price-tier)

---

## 7. How your data is protected

- **At rest:** message and email bodies are encrypted with AES-256-GCM.
- **Chat:** new direct and channel messages are end-to-end encrypted — the
  browser encrypts an envelope per participant; the server only ever stores
  ciphertext it cannot read.
- **API keys:** scoped, expiring, rate-limited, hashed, and fully audited.
- **Authorization:** evaluated per request from the database, never trusted
  from the token.

---

## Where to go next

- Browse everything: [/docs](/docs)
- Try the API live: [/docs/api](/docs/api)
- Follow a tutorial: [/docs/developers](/docs/developers)
- Check your limits: [/docs/quotas](/docs/quotas)
