# Price Tiers & Event Producers

A single reference for the two long-term API contracts Wayve sells against:

1. **Per-customer rate-limit tiers** — what a customer is entitled to consume.
2. **App event producers** — what Wayve will push back when those customers
   subscribe to webhooks.

Both surfaces are documented here so a procurement reviewer or integration
engineer can answer two questions in one place: *"What's my budget?"* and
*"What can I subscribe to?"*

---

## 1. Rate-limit tiers

There are four tiers. Each ships with a documented requests-per-minute cap
and a monthly request budget. The numbers below are the source of truth and
match the `plans` table columns `rate_limit_per_min` and `monthly_quota`.

| Tier | Plan code | Price | Rate limit | Monthly requests |
| --- | --- | --- | --- | --- |
| Free | `basic_user` | $0 | 60 / min | 50,000 |
| Advance | `advance_user` | $7 / month | 300 / min | 500,000 |
| Organization | `organization` | $10 / seat / month | 600 / min | 5,000,000 |
| Enterprise | `enterprise` | Custom | 6,000 / min | Unlimited |

### How the cap is computed

Every authenticated request resolves an *effective* cap as
`MIN(api_key.rate_limit_per_min, plan.rate_limit_per_min)`. Issuing a key
with a stricter `rate_limit_per_min` than the plan keeps the stricter
value. The plan acts as a ceiling, never a floor.

The monthly counter aggregates across **every** API key a single user
owns. Splitting workload across multiple keys does not multiply the budget.
A request that exhausts the monthly budget returns:

```text
HTTP/1.1 429 Too Many Requests
{ "message": "Monthly request quota exceeded for this plan.
              Upgrade or wait for the next cycle." }
```

### Cycle reset

The monthly counter is a Redis key with the form
`apikey_quota:{user_id}:{YYYY-MM}` and a 32-day TTL. It resets at
`00:00 UTC` on the **first of every calendar month** — independent of
the customer's Stripe billing anniversary, which can land mid-month.

### Fail-open semantics

If Redis is unreachable, both the per-minute and monthly counters fail
open. Availability beats strictness for the data API. Every dropped
enforcement is recorded in the API-key audit log so an operator can see
what slipped through, and the quota briefly relaxes for affected users.

### Endpoints

- `GET /api/billing/tiers` (public)
  — list every active tier with its rate-limit and monthly-quota columns.
  Feeds the public `/developers/quotas` comparison page.

- `GET /api/billing/quota` (authenticated)
  — the calling user's resolved tier plus current-cycle usage. Includes a
  `cycle_resets_at` ISO timestamp so a dashboard can render
  "Resets in 14 days".

---

## 2. App event producers

The API push side ("webhooks") fans out events to customer endpoints. The
catalog is frozen as a long-term contract — adding a type is non-breaking;
renaming or removing one is breaking and would ship under a new
`info.version`.

Every event arrives as a signed JSON envelope:

```json
{
  "id":          "evt_<uuid>",
  "type":        "<event.type>",
  "api_version": "2026.05",
  "created_at":  "2026-05-24T13:45:00Z",
  "owner":       { "type": "user",
                   "user_id": 42,
                   "organization_id": null },
  "data":        { /* event-specific payload */ }
}
```

### Tasks

| Event | Fires from | Payload |
| --- | --- | --- |
| `task.created` | `backend/src/tasks/handler.rs` — `POST /api/tasks` | Full task row: `id`, `name`, `description`, `priority`, `status`, `created_at`, `updated_at`. |
| `task.updated` | Same module — `PUT /api/tasks/{id}` | Same shape as `task.created` reflecting the post-edit values. |
| `task.deleted` | Same module — `DELETE /api/tasks/{id}` | `{ "id": <integer> }` |

### Meetings

| Event | Fires from | Payload |
| --- | --- | --- |
| `meeting.created` | `backend/src/scheduler/handler.rs` — `POST /api/meetings` | `id`, `title`, `date`, `start_time`, `end_time`, `zoom_join_url`, `participants[]`. |
| `meeting.updated` | Same module — `PUT /api/meetings/{id}` | Same shape + `content_changed` boolean indicating whether title / date / start / end changed. |
| `meeting.deleted` | Same module — `DELETE /api/meetings/{id}` | `{ "id": <integer> }` |

### Email

| Event | Fires from | Payload |
| --- | --- | --- |
| `email.received` | `backend/src/email/sync.rs` — every sync tick (default 30s). Filtered to **true inserts only** using the `xmax = 0` flag, so it does **not** fire on body backfills or label updates. | `id`, `account_id`, `sender`, `subject`, `received_at`. Body intentionally omitted; fetch via `GET /api/emails/{id}` with the `email:read` scope if you need it. |
| `email.sent` | `backend/src/email/send.rs` — `POST /api/email/send` after the upstream provider returns 2xx. | `account_id`, `from`, `to`, `subject`, `sent_at`. Body omitted. |

### Chat

| Event | Fires from | Payload |
| --- | --- | --- |
| `chat.message.sent` | `backend/src/chat/websocket.rs` — both DM and channel branches, fired immediately after the database INSERT succeeds. | Direct: `message_id`, `sender_id`, `recipient_id`, `is_direct: true`. Channel: `message_id`, `channel_id`, `sender_id`, `is_direct: false`, `parent_message_id`. Content is **end-to-end encrypted** — the server cannot include it in the payload. Subscribers wanting bodies must hold the recipient's private key. |
| `chat.channel.created` | `backend/src/chat/channel_create.rs` — strictly after the channel-create transaction commits. | `id`, `name`, `created_by`, `created_at`, `member_ids[]`. |

### Test

| Event | Fires from | Payload |
| --- | --- | --- |
| `wayve.ping` | `POST /api/webhooks/{id}/test` — synthetic delivery enqueued directly into `webhook_deliveries` so a customer can verify endpoint wiring without waiting for real activity. | `{ "message": "If you can read this, your endpoint is wired up." }` |

### Throughput characteristics

- `email.received` is the **highest-volume** producer per mailbox.
  Plan for ~30 events per minute per actively-used mailbox in the worst
  case. The dispatcher claim batch is 25 per 5-second tick, so a
  customer subscribed across many active mailboxes may see brief
  in-queue delays before delivery.
- `chat.message.sent` is **per message**. For a busy organization
  this is the highest-volume event overall. Receivers that cannot
  match this throughput should put a queue between Wayve and their
  business logic; the dispatcher will retry and eventually abandon
  failing endpoints (3 attempts at 0s, 1m, 5m; auto-disable after
  20 consecutive failed deliveries).
- Webhook delivery is **outbound** from Wayve and is **not** metered
  against the inbound rate-limit tier. A Free-tier customer can subscribe
  to every event and receive uncapped deliveries; the tier limits the
  inbound API calls the customer makes back at Wayve to act on those
  deliveries.

---

## 3. How tiers and events relate

The two contracts are deliberately decoupled:

- **Rate-limit tiers** meter **inbound** requests from a customer's API
  keys (`X-API-KEY` header). They protect Wayve from a single tenant
  exhausting shared capacity.
- **Event producers** drive **outbound** HTTP POSTs from Wayve to the
  customer's URL. They are not counted against the customer's quota
  because the customer didn't initiate them.

A common integration uses both surfaces: an event fires
(`email.received` → POST to `/customer/wayve`), the customer's
handler then calls back into Wayve (e.g. `GET /api/emails/{id}`) to
fetch the body. That GET counts against the customer's tier; the
preceding push does not.

This is also why the `/developers/quotas` page never displays a
"webhooks per month" stat — there is no such cap to display.

---

## 4. Where this lives in code

| Concern | File |
| --- | --- |
| Tier catalog + backfill | `backend/src/startup.rs` (search `rate_limit_per_min`) |
| Effective quota helper (Moka-cached) | `backend/src/billing/quotas.rs` |
| Public + authenticated quota endpoints | `backend/src/billing/tiers.rs` |
| Rate-limit + monthly-quota enforcement | `backend/src/middleware/api_key.rs` |
| Event type enum + emit() fan-out | `backend/src/webhooks/events.rs` |
| Delivery worker (retry, signing, auto-disable) | `backend/src/webhooks/dispatcher.rs` |
| Customer-facing webhook CRUD + test endpoint | `backend/src/webhooks/handler.rs` |
| Frontend tier-comparison page | `frontend/src/marketing/Quotas.tsx` — mounted at `/developers/quotas` |
| Frontend webhook management | `frontend/src/settings/Webhooks.tsx` — mounted at `/settings/webhooks` |

---

## 5. Document version

API surface version: **2026.05**. Producers and tiers documented in this
file ship at this version. Future additions land here under a new section;
breaking changes (renames, removals, payload-shape changes) ship under a
new `info.version` and a deprecation entry on the OpenAPI spec.
