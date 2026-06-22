# Chat message display — who sent / who received

How the chat feed shows **who sent each message**, so a multi-person channel (and
the Slack bridge) is readable. Rendering lives in
[`MessageThread.tsx`](../../frontend/src/chat/components/MessageThread.tsx);
the sender name comes from the backend.

## What you see

| Message | Alignment | Label |
|---|---|---|
| **Your own** | right | none (it's obviously yours) + read/delivered ticks |
| **Another Wayve user** (channel) | left | initials **avatar** + their **name** (username, else email) |
| **Bridged from Slack** | left | a **`Slack`** badge + the **Slack author**, text cleaned |

A message is "yours" when `sender_id === currentUserId` — **except** Slack-bridged
messages, which are always rendered as received (see below).

## Where the sender name comes from

Channel messages carry a `sender_name` (DMs don't — a 1-on-1 peer is already known):

- **Historical reads** — `chat/channel_messages.rs` `LEFT JOIN users` and selects
  `COALESCE(NULLIF(u.username, ''), u.email) AS sender_name` for both the feed and
  thread queries; `row_to_message_json` emits it.
- **Realtime** — `chat/websocket.rs` resolves the sender's display name **once at
  connect** (cached on `ChatSession.sender_name`, like `uses_standard_encryption`)
  and includes it in the channel broadcast payload — no per-message user lookup.
- Frontend type: `ChatMessage.sender_name?: string | null`
  ([`api/chat.ts`](../../frontend/src/api/chat.ts)). `null`/absent → no label
  (legacy rows, DMs).

## Slack-bridged messages

Inbound Slack messages are stored as `"[Slack · <author>] <text>"` under the
**connecting** Wayve user's id (the per-org Slack connection's `connected_by`). So
without special handling they'd render as the *viewer's own* message. `MessageThread`:

1. Detects the `[Slack · <author>] …` shape (`SLACK_RE`).
2. Forces `mine = false` → renders **received** (left), with a `Slack` badge + the
   parsed author, and a Slack-purple accent (`.bubble--slack`).
3. **Cleans Slack markup** in the text: `<@U…>` / `<@U…|name>` → `@name`,
   `<#C…|name>` → `#name`, `<url|label>` → `label`.

This is frontend-only — the stored content and the `sender_name` are untouched; the
Slack author shown comes from the content prefix, not `sender_name`.

## Files

- `backend/crates/wayve-server/src/chat/channel_messages.rs` — `sender_name` in reads.
- `backend/crates/wayve-server/src/chat/websocket.rs` — `ChatSession.sender_name`,
  resolved at connect, added to the channel broadcast payload.
- `frontend/src/api/chat.ts` — `ChatMessage.sender_name`.
- `frontend/src/chat/components/MessageThread.tsx` — sender label, initials avatar,
  Slack parsing/cleanup.
- `frontend/src/chat/chat.css` — `.bubble-sender`, `.bubble-sender-badge`,
  `.bubble-avatar`, `.bubble--slack`.

## Not covered (possible follow-ups)

- **Grouping** consecutive messages from the same sender under one header.
- A real avatar image (today it's deterministic initials + colour).
- DMs intentionally show no per-message sender (the peer is fixed).
