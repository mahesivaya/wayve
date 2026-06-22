# Slack setup for Fluxze (Enterprise)

A complete, self-service guide for an Enterprise customer to connect a Slack
workspace to Fluxze so Slack and Wayve channels stay in sync.

**Slack is Enterprise-only.** It relies on standard (server-readable) encryption,
so the Slack tile and endpoints appear only for Enterprise organizations.
Personal/Business (end-to-end encrypted) orgs cannot use it.

## What you get (three flows)

| Flow | Direction | What it does |
|---|---|---|
| **Import** | Slack → Wayve | Pull a Slack channel's history into a Wayve channel (on demand) |
| **Outbound** *(automatic once linked)* | Wayve → Slack | A message in a linked Wayve channel is posted to Slack |
| **Events webhook** | Slack → Wayve | A new Slack message appears in Wayve **immediately** |

## ✅ Quick checklist (do these in order)

1. Create a Slack app + add **all four** bot scopes.
2. **Install / Reinstall** the app to your workspace *(scopes don't apply until you do)*.
3. Copy the **Bot token** (`xoxb-…`) and the **Signing Secret**.
4. In Fluxze → **Integrations → Slack** → **Connect** with the bot token → **Link** a channel.
5. **`/invite @YourApp`** into each Slack channel you bridge *(required — see Step 4)*.
6. Set `SLACK_SIGNING_SECRET` on the server + turn on **Event Subscriptions** (for real-time).
7. Post a message and watch it sync both ways.

> ⚠️ The two most common mistakes — and they fail **silently** — are **(a)** adding
> scopes without **reinstalling**, and **(b)** not **inviting the bot to the
> channel**. Steps 2 and 5 below cover them.

---

## Step 1 — Create the Slack app + scopes

1. **https://api.slack.com/apps → Create New App → From scratch** → name it
   (e.g. `Fluxze`) → pick your workspace.
2. **OAuth & Permissions → Scopes → Bot Token Scopes → Add an OAuth Scope** and add
   **all four** (search each by its exact name):

   | Scope | Why it's needed |
   |---|---|
   | `channels:read` | List channels ("Load channels") |
   | `channels:history` | Read/import messages |
   | `chat:write` | Post Wayve → Slack (outbound) |
   | `users:read` | Show the Slack author's name |

   > These are *bot* scopes (left column). Don't confuse `chat:write` (under
   > **chat:**) with the `channels:write:*` scopes (managing channels) — you don't
   > need those.

## Step 2 — Install / Reinstall (critical)

Click **Install to Workspace** (first time) or **Reinstall to Workspace** (if you
added scopes later) → **Allow**.

> 🔴 **Adding a scope does nothing until you reinstall.** A token that's missing a
> scope fails with `missing_scope` (e.g. "Load channels" → error). Any time you
> change scopes, **reinstall** and re-copy the token.

## Step 3 — Copy the two credentials

| Credential | Where | Looks like |
|---|---|---|
| **Bot User OAuth Token** | OAuth & Permissions | `xoxb-…` |
| **Signing Secret** | Basic Information → App Credentials → **Show** | ~32-char hex (no `xox` prefix) |

> The Signing Secret is **not** a token and does **not** start with `xox`. It's
> only needed for the real-time webhook (Step 6).

## Step 4 — Connect + link in Fluxze

1. Fluxze → **Integrations → Slack** (Enterprise account).
2. Paste the **`xoxb-…`** bot token → **Connect** (stored encrypted at rest).
3. **Load channels** → **Link** the Slack channel you want. This **creates a Wayve
   channel** for it — that's the one that shows under **Messages**.
4. *(optional)* **Import** to pull recent history in.

## Step 5 — Invite the bot to each channel (required) 🔑

In Slack, open **every channel you linked** and run:
```
/invite @YourApp
```
*(or: channel name → **Integrations** → **Add apps** → add your app).*

**This is required for both directions** and is the #1 thing people miss:
- **Outbound:** `chat.postMessage` to a channel the bot isn't in fails with
  **`not_in_channel`** — so your Wayve message silently never reaches Slack.
- **Inbound:** Slack only sends `message` events for channels the bot is **in**.
- Listing channels ("Load channels") works *without* membership, which is why this
  is easy to overlook.

At this point **Import** and **Outbound** both work. For *real-time* inbound, do
Step 6.

---

## Step 6 — Real-time inbound (Slack Events webhook)

Without this, new Slack messages only arrive when someone clicks **Import**. The
webhook makes them appear immediately. Slack **HMAC-signs** every request with the
**Signing Secret** (no `?token=` in the URL); Fluxze verifies it against
`SLACK_SIGNING_SECRET`.

### 6a. Set the signing secret on the server (admin)

```bash
# on the Fluxze host
cd /home/ubuntu/rwayve
sed -i '/^SLACK_SIGNING_SECRET=/d' backend/.env.production
echo 'SLACK_SIGNING_SECRET=<the app Signing Secret from Step 3>' >> backend/.env.production
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production \
  up -d --no-build --force-recreate backend
```

> Unset secret → the endpoint returns `503` and refuses all deliveries.

### 6b. Enable Event Subscriptions in the Slack app

1. Slack app → **Event Subscriptions** → toggle **Enable Events** to **On**.
2. **Request URL:**
   ```
   https://fluxze.com/webhooks/slack_events
   ```
   Slack sends a signed challenge → Fluxze echoes it → field flips to **Verified ✓**.
   *(No `?token=` — auth is the signature.)*
3. **Subscribe to bot events** → add **`message.channels`** *(public channels)*.
4. **Save Changes** → **reinstall** if prompted.

### 6c. Test

Post a message in a linked Slack channel (where the bot is a member) → it appears
in the mapped Wayve channel within seconds, as `[Slack · <name>] <text>`. Messages
the Fluxze bot itself posts (your outbound) are ignored, so there's **no echo loop**.

---

## Quick reference

| Value | Used for | Where you get it | Format |
|---|---|---|---|
| **Bot token** | Connect / import / outbound | OAuth & Permissions | `xoxb-…` |
| **Signing secret** | Events webhook | Basic Information → App Credentials | ~32-char hex |
| **Request URL** | Events webhook | fixed | `https://fluxze.com/webhooks/slack_events` |
| **`message.channels`** | Events webhook | Event Subscriptions → bot events | — |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Slack tile missing in Fluxze | Not an Enterprise org | Slack is Enterprise-only |
| Connect → `401` | Bad token / app not installed | Reinstall, re-copy `xoxb-…` |
| Load channels → **`missing_scope`** | Scope not added **or not reinstalled** | Add `channels:read` → **Reinstall** (Step 2) |
| **Wayve → Slack silently does nothing** | Bot not in the channel | **`/invite @YourApp`** into that channel (Step 5) |
| `chat.postMessage` → **`not_in_channel`** | Same as above | `/invite @YourApp` |
| Posting in Wayve does nothing | Posting in the wrong (unlinked) channel | Post in the **linked** Wayve channel |
| Event URL won't verify / `503` | `SLACK_SIGNING_SECRET` wrong or unset | Set it = the app Signing Secret, redeploy |
| New messages need Import | Event Subscriptions off / `message.channels` missing | Enable + subscribe + reinstall |
| Webhook → `405` | nginx not routing `/webhooks/` | Admin: nginx must proxy `/webhooks/` |

> Outbound is **best-effort** — a Slack failure never blocks your Wayve message, so
> it fails *silently*. If Wayve → Slack isn't working, it's almost always **(1) bot
> not in the channel** or **(2) `chat:write` not granted/reinstalled**.

---

## Security notes

- **Bot token** — encrypted at rest in Fluxze; never paste it into chats/tickets.
  If it leaks, rotate it (OAuth & Permissions → Reinstall) and reconnect in Fluxze.
- **Signing secret** — only authenticates inbound events. To rotate, update both the
  Slack app and `SLACK_SIGNING_SECRET` on the server (they must match).
- Inbound/outbound Slack content is **server-readable** (Enterprise standard
  encryption) — which is exactly what makes the bridge possible.
