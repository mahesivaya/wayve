The Wayve API exposes Wayve's first-party products — email, chat, scheduling,
drive, notes, tasks, and AI — as scoped HTTP endpoints suitable for backend
automation, custom integrations, and self-hosted bots.

This description ships with the spec, so SDK generators and IDE OpenAPI
plug-ins (Stoplight, Postman, openapi-generator, swagger-codegen, etc.)
inherit the same getting-started guidance their consumers see in the web
portal at [/developers](/developers).

## Authentication

Every endpoint requires an `X-API-KEY` header carrying a key issued from the
Wayve dashboard. There is no OAuth 2.0 authorisation server in this version;
keys act on behalf of the user who minted them, and are constrained by:

- **Scopes** — the operation surfaces the key may invoke. A key with
  `notes:read` cannot call `POST /api/tasks`; the gateway returns `403`.
- **Expiry** — every external key has a mandatory expiry; internal keys may
  be open-ended.
- **Rate limit** — per-key requests/minute, enforced by the gateway. A
  rate-limited request returns `429` and is *not* counted against the quota,
  so it is safe to retry with exponential backoff.

Every request is recorded in an append-only audit log that key owners can
review from the dashboard.

### Header

```
X-API-KEY: wv_sk_<48-char-hex>
```

Keys are issued with prefix `wv_sk_` so leak detectors (TruffleHog, GitGuardian)
recognise them. If you spot a key in source control, revoke it from the
dashboard — revocation is effective on the next request.

## Rate limits & quotas

Two ceilings apply to every API-key request:

| Tier | Plan code | Price | Rate limit | Monthly requests |
| --- | --- | --- | --- | --- |
| Free | `basic_user` | $0 | 60 / min | 50,000 |
| Advance | `advance_user` | $7 / month | 300 / min | 500,000 |
| Organization | `organization` | $10 / seat / month | 600 / min | 5,000,000 |
| Enterprise | `enterprise` | Custom | 6,000 / min | Unlimited |

Behaviour:

- A request that exceeds the rate limit returns **`429 Too Many Requests`** —
  retry safely after the next 60-second window.
- A request that exhausts the monthly request budget returns
  `429 Too Many Requests` with a message naming the plan. The cycle resets
  at `00:00 UTC` on the first of every calendar month (separate from your
  Stripe billing anniversary).
- The monthly counter aggregates across **every** API key you own. Splitting
  workload across multiple keys does not multiply your budget.
- Issuing a key with a `rate_limit_per_min` stricter than the plan cap keeps
  the stricter value. The plan cap is a ceiling, not a floor.

Compare tiers and current usage in the dashboard at
[/developers/quotas](/developers/quotas), or query
`GET /api/billing/tiers` (public) and `GET /api/billing/quota`
(authenticated) directly.

## Choosing scopes

| If your integration… | Use scope(s) |
| --- | --- |
| Reads mailboxes, lists messages | `email:read` |
| Sends mail / marks read | `email:send` (also covers state mutation) |
| Reads or posts to chat | `chat:read`, `chat:write` |
| Creates / reads meetings | `scheduler:read`, `scheduler:write` |
| Lists or downloads files | `drive:read` |
| Uploads, shares, deletes files | `drive:write` |
| Manages personal notes | `notes:read`, `notes:write` |
| Manages tasks / to-dos | `tasks:read`, `tasks:write` |
| Sends prompts to the assistant | `ai:use` |
| Identifies the calling principal | `profile:read` (recommended for every key — used by `/api/me`) |

Internal keys (admin/system integrations) can additionally request `admin`
or the wildcard `*` scope. Both are gated to platform-owner accounts and
should never be used from a browser, mobile binary, or untrusted host.

## Errors

All non-2xx responses follow the same envelope:

```json
{ "message": "Human-readable reason." }
```

| Status | Meaning | Retry safe? |
| ------ | ------- | ----------- |
| 400    | Malformed request body or query. | After fixing payload |
| 401    | Missing, invalid, revoked, or expired API key. | No — mint a new key |
| 403    | Key valid but lacks the required scope (see `x-scope`). | No — request scope upgrade |
| 404    | Resource does not exist or is not visible to this principal. | No |
| 429    | Per-key rate limit exceeded. | Yes — exponential backoff |
| 5xx    | Internal failure. | Yes — idempotent requests only |

The `x-scope` extension on every operation tells you exactly which scope a
403 means you're missing.

## Versioning

The current public surface is **2026.05**. Stable endpoints keep their
operation IDs and request/response shapes for at least 12 months after any
breaking change is announced. Endpoints under `/api/v1/*` are explicitly
versioned and freeze separately.

Breaking changes are communicated by:

1. A new `info.version` (year.month).
2. An entry in `info.x-deprecation` listing the affected operation IDs.
3. An email to every account holding an affected key.

## Pagination

List endpoints accept `limit` (defaults vary, max 200) and return a `cursor`
in the response body for paged collections. To fetch the next page, pass the
cursor back as a query parameter.

## SDKs

The spec is the source of truth. To generate a client, point any
OpenAPI 3.1-aware generator at `https://maheshg.me/api/openapi.json`:

```bash
# TypeScript / fetch
npx @hey-api/openapi-ts -i https://maheshg.me/api/openapi.json -o ./wayve

# Python / httpx
openapi-python-client generate --url https://maheshg.me/api/openapi.json

# Go
oapi-codegen -package wayve https://maheshg.me/api/openapi.json > wayve.gen.go
```

A spec change updates the ETag so generators with caching can short-circuit
regeneration when nothing has changed.

## Outbound webhooks

In addition to calling Wayve, your app can have Wayve push events to **you**.
Register an endpoint at `POST /api/webhooks` with a list of subscribed event
types; Wayve will deliver every matching event as a signed JSON payload.

### Subscribing

```bash
curl https://maheshg.me/api/webhooks \
  -H "X-API-KEY: $WAYVE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/wayve/webhook",
    "events": ["task.created", "meeting.created"],
    "description": "CRM sync"
  }'
```

The response body contains a `secret` shown **exactly once** — store it
securely.

### Event envelope

```json
{
  "id":          "evt_<uuid>",
  "type":        "task.created",
  "api_version": "2026.05",
  "created_at":  "2026-05-24T13:45:00Z",
  "owner":       { "type": "user", "user_id": 42, "organization_id": null },
  "data":        { /* event-specific payload */ }
}
```

### Verifying the signature

Every delivery carries `Wayve-Signature: t=<timestamp>,v1=<hmac>`.
Verify by recomputing `HMAC_SHA256(secret, "<timestamp>.<raw_body>")` and
comparing in constant time. Reject anything older than ~5 minutes to prevent
replay attacks.

### Event types (v1)

| Type | Fires when | Payload notes |
| --- | --- | --- |
| `task.created` | A task is created. | Full task row. |
| `task.updated` | A task is edited. | Full task row. |
| `task.deleted` | A task is deleted. | `{ id }` only. |
| `meeting.created` | A meeting is scheduled. | Title, date, start/end, participants, optional Zoom URL. |
| `meeting.updated` | A meeting is edited. | Same shape + `content_changed` flag. |
| `meeting.deleted` | A meeting is cancelled. | `{ id }` only. |
| `email.received` | Sync ingests a row that was *not* previously in the mailbox. NOT fired on body backfills or label updates. | `id`, `account_id`, `sender`, `subject`, `received_at`. **Body is intentionally omitted** — fetch via `GET /api/emails/{id}` if you have `email:read`. |
| `email.sent` | `/api/email/send` returns 2xx from the upstream provider. | `account_id`, `from`, `to`, `subject`, `sent_at`. Body omitted. |
| `chat.message.sent` | A direct or channel message is persisted. | `message_id`, `sender_id`, plus `channel_id` *or* `recipient_id`, `is_direct`. **Content is end-to-end encrypted; the server cannot include it** in the payload. Subscribers wanting message bodies need an integration that holds the recipient's private key. |
| `chat.channel.created` | A new chat channel is created. | `id`, `name`, `created_by`, `created_at`, `member_ids`. |
| `wayve.ping` | Test event fired by `POST /api/webhooks/{id}/test`. | `{ message }`. |

Subscribe to `"*"` to receive every event.

### Throughput characteristics

`email.received` can fan out tens of events per sync tick when an active
mailbox is connected. Plan for ~30 events per minute per active mailbox in
the worst case. If you only need *unread* mail, filter on the row you fetch
in your handler rather than asking us to filter — we don't promise to add
event subtypes.

`chat.message.sent` fires per message. For a busy organization this is the
highest-volume event; if your endpoint can't keep up, the dispatcher will
back off (see Delivery semantics below) but will eventually mark the
endpoint abandoned. Consider running a queue between Wayve and your
business logic.

### Delivery semantics

- HTTP `2xx` → delivered.
- HTTP `4xx` (other than `408`/`429`) → abandoned; payload was rejected.
- HTTP `5xx` / network errors / `429` → retried 3 times at 0s, 1m, 5m.
- After 20 consecutive failed deliveries Wayve disables the endpoint.

## Tutorials

Worked end-to-end examples (send your first email, create a task, schedule a
meeting, run an AI prompt) live in the
[Developers portal Tutorials section](/developers#tutorials).
