# Realtime chat reliability

How the chat WebSocket stays connected, never loses messages across drops, and
scales across more than one backend instance. Three independent layers:

1. **Resilience** — the connection self-heals (heartbeat + client reconnect).
2. **Lossless** — reconnects backfill anything missed (`since_id` resync).
3. **Scale** — fan-out goes through Redis pub/sub so any instance can deliver.

---

## Architecture overview

- Endpoint: `GET /ws/chat` → `ChatSession` actor
  ([backend/.../chat/websocket.rs](../../backend/crates/wayve-server/src/chat/websocket.rs)),
  authenticated via JWT/cookie/API-key (with a `?token=` fallback).
- Message lifecycle on send: client sends the E2E envelope text →
  `StreamHandler` validates (must start with `WAYVE_CHAT_E2E_V1`, membership /
  same-scope checks) → AES-GCM encrypts the envelope at rest → INSERT into
  `messages` / `channel_messages` → **fan-out** to recipients → echo back to the
  sender (`ctx.text`).
- The browser keeps the socket via [useChatSocket.ts](../../frontend/src/chat/hooks/useChatSocket.ts);
  the composer ([MessageComposer.tsx](../../frontend/src/chat/components/MessageComposer.tsx))
  is enabled only while `isConnected`.

---

## Tier 1 — Connection resilience

**Why:** nginx closes an idle WebSocket after its `proxy_read_timeout`
(default **60s**). With no server heartbeat and no client reconnect, the socket
silently died and the composer stayed disabled until a full reload.

- **Server heartbeat** (`ChatSession`): pings every `HEARTBEAT_INTERVAL` (**25s**)
  via `ctx.run_interval`; the browser auto-pongs. `last_seen` is refreshed on any
  inbound frame; if nothing arrives within `CLIENT_TIMEOUT` (**60s**) the socket
  is dropped (dead/half-open client detection).
- **Client reconnect** (`useChatSocket`): on `onclose`, reconnect with capped
  exponential backoff **+ jitter** (~1s, 2s, 4s … max 15s, ±20%). Backoff resets
  on open. A "reconnecting…" status replaces the silently-disabled box.
- **nginx**: `/ws/` blocks set `proxy_read_timeout`/`proxy_send_timeout` to
  **3600s** in all three templates (`nginx.conf.template`,
  `nginx.dev.conf.template`, `nginx.prod.conf.template`) — comfortably above the
  25s heartbeat. (Prod requires a redeploy / nginx force-recreate to apply.)

---

## Tier 2 — Lossless resync on reconnect

**Why:** the history endpoints only returned the latest 50 messages, so anything
sent during a drop was lost until the user reselected the conversation.

- **Backend**: `GET /api/chat/direct-messages` and `/api/chat/channel-messages`
  accept an optional `since_id`. When set, they return messages with `id >
  since_id` in **chronological** order (capped at 500); otherwise the original
  "latest 50, newest-first" behavior is unchanged. Tenant/membership checks are
  preserved. No schema change — uses the existing `id` PKs.
- **Frontend**: on every socket (re)open, `useChatSocket` calls an `onOpen`
  callback. `Chat.tsx` backfills the open conversation by fetching with
  `since_id = max(message_id held)` and merging, **deduped by `message_id`**.

---

## Tier 3 — Horizontal scale (Redis pub/sub)

**Why:** broadcast used an in-process `HashMap<user_id, Addr>`
([ws_registry.rs](../../backend/crates/wayve-server/src/ws_registry.rs)), so a
message only reached recipients connected to the **same** backend instance —
chat broke with >1 instance and every socket dropped on each deploy.

- **Publish**: `Cache::publish(channel, payload)` (`PUBLISH`). Each fan-out site
  in `websocket.rs` (DM, channel message, read receipt) calls
  `fan_out_user(cache, user_id, payload)`, which publishes to `ws:user:{id}`.
- **Subscribe**: [chat/pubsub.rs](../../backend/crates/wayve-server/src/chat/pubsub.rs)
  runs one subscriber per process (spawned in `main` when Redis is available),
  `PSUBSCRIBE ws:user:*`, and delivers each frame to the matching **local**
  session via `deliver_local`. So whichever instance holds the recipient's
  socket delivers it.
- **Graceful degradation**: if `publish` fails (Redis down) `fan_out_user` falls
  back to local delivery — single-instance keeps working without Redis. Exactly
  one delivery path runs, so no duplicates.
- **Known limitation**: the "delivered" receipt is gated on **local** presence,
  so on a multi-instance deployment it may be missed when the recipient is on
  another instance (message delivery itself is unaffected). A shared presence
  registry in Redis would close this gap (future work).

### Running more than one backend instance
The code is now multi-instance-correct, but actually scaling out is a separate
ops step: drop the fixed `container_name` in `infra/docker-compose.prod.yml` and
run replicas (or move to an orchestrator). Redis must be reachable from all
instances (it already is).

---

## Operational notes
- **Env**: realtime fan-out across instances needs Redis (`REDIS_URL`). Without
  it, chat still works on a single instance (local fallback).
- **Tuning**: heartbeat 25s / client-timeout 60s / nginx idle 3600s — keep the
  heartbeat well under both timeouts if you change them.

### Automated tests
- `backend/.../tests/redis_pubsub_perf_test.rs` — pub/sub round-trip
  correctness + latency and publish throughput against the `ws:user:{id}`
  channel contract. Gated on a reachable Redis (skips otherwise); CI provides a
  `redis` service + `REDIS_URL` so it runs there.
- `backend/.../tests/chat_logging_test.rs` — captures tracing output via a
  thread-local subscriber and asserts the chat WS handler logs its
  `target = "ws"` auth-rejection (and returns 401). No DB/Redis needed.

### How to test each tier manually
- **Tier 1**: open chat, idle >2 min → composer stays enabled. Briefly drop
  network → "reconnecting…" → recovers, composer re-enables.
- **Tier 2**: have a second user send while you're briefly offline → on
  reconnect the missed messages appear in the open conversation.
- **Tier 3**: `docker compose up --scale backend=2` (dev) → two users on
  different instances exchange messages. Stop Redis → single-instance still
  works.
