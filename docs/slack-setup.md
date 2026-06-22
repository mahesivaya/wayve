# Slack setup for Fluxze (Enterprise)

How to bridge a Slack workspace with Fluxze so Slack channels and Wayve channels
stay in sync. **Slack is an Enterprise-tier feature** — it relies on standard
(server-readable) encryption, so the tile and endpoints are available only to
Enterprise organizations.

There are **three** flows; Parts 1–2 are the base bridge, Part 3 adds real-time:

| Flow | Direction | What it does |
|---|---|---|
| **Connect + link + import** (Part 1) | Slack → Wayve | Pull a Slack channel's history into a Wayve channel (on demand) |
| **Outbound** (automatic once linked) | Wayve → Slack | A message in a linked Wayve channel is posted to Slack |
| **Events webhook** (Part 2) | Slack → Wayve | A **new** Slack message appears in the Wayve channel **immediately** |

---

## Part 0 — Create a Slack app

1. Go to **https://api.slack.com/apps → Create New App → From scratch**. Name it
   (e.g. `Fluxze`) and pick your workspace.
2. **OAuth & Permissions → Bot Token Scopes** — add:
   `channels:history`, `channels:read`, `chat:write`, `users:read`.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App Credentials** — copy the **Signing Secret** (needed
   for Part 2).
5. Invite the bot to each channel you want to bridge: in Slack, `/invite @Fluxze`.

---

## Part 1 — Connect, link, and import

This is the **Slack → Wayve** (and automatic **Wayve → Slack**) bridge.

1. In Fluxze, open **Integrations → Slack** (visible only on Enterprise).
2. Paste the **bot token** (`xoxb-…`) → **Connect**. Fluxze validates it
   (`auth.test`) and stores it encrypted at rest.
3. **Load channels**, then **Link** a Slack channel — Fluxze creates a Wayve
   channel mapped to it.
4. **Import** — pulls that channel's recent history into the Wayve channel.

After linking, any message a Wayve user posts in the linked channel is
automatically posted back to Slack. (Imported/synced messages are
**server-readable** — Enterprise chat is not end-to-end encrypted.)

---

## Part 2 — Real-time inbound (Slack Events webhook)

Without this, new Slack messages only arrive when someone clicks **Import**. The
Events webhook makes them appear **immediately**.

Slack authenticates this differently from Jira: it **HMAC-signs every request**
with your app's **Signing Secret** (there is no `?token=` in the URL). Fluxze
verifies `X-Slack-Signature` against `SLACK_SIGNING_SECRET`.

### 1. Set the signing secret on the Fluxze server (admin step)

```bash
# on the Fluxze host
cd /home/ubuntu/rwayve
sed -i '/^SLACK_SIGNING_SECRET=/d' backend/.env.production
echo 'SLACK_SIGNING_SECRET=<your Slack app Signing Secret>' >> backend/.env.production
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production \
  up -d --no-build --force-recreate backend
```

> If `SLACK_SIGNING_SECRET` is unset, the endpoint returns `503` and refuses all
> deliveries.

### 2. Enable Event Subscriptions in the Slack app

1. In your Slack app → **Event Subscriptions** → toggle **On**.
2. **Request URL:**
   ```
   https://fluxze.com/webhooks/slack_events
   ```
   Slack immediately sends a verification request; Fluxze echoes the challenge,
   so the field should flip to **Verified ✓**. (No `?token=` — auth is the
   signature, not the URL.)
3. **Subscribe to bot events** → add **`message.channels`** (messages in public
   channels the bot is in).
4. **Save Changes**, then **reinstall** the app if Slack prompts.

### 3. Verify

```bash
# connectivity (a real delivery is signed, so this is just an auth probe):
curl -i -X POST https://fluxze.com/webhooks/slack_events \
  -H 'Content-Type: application/json' \
  -d '{"type":"url_verification","challenge":"ping"}'
# Without a valid X-Slack-Signature this returns 401 — that's expected; Slack's
# own requests are signed. 503 here instead means SLACK_SIGNING_SECRET is unset.
```

Real test: post a message in a **linked** Slack channel → it appears in the
mapped Wayve channel within seconds. Messages **the Fluxze bot itself posts**
(your Wayve → Slack outbound) are ignored, so there's no echo loop.

---

## Quick reference

| Value | Used for | Where you get it |
|---|---|---|
| **Bot token** (`xoxb-…`) | Connect / import / outbound | Slack app → OAuth & Permissions |
| **Signing secret** | Events webhook | Slack app → Basic Information → App Credentials |
| **Request URL** | Events webhook | Fixed: `https://fluxze.com/webhooks/slack_events` |
| **`message.channels`** | Events webhook | Slack app → Event Subscriptions → bot events |

`SLACK_SIGNING_SECRET` on the server must equal the Slack app's **Signing
Secret** — that's the whole auth for the webhook.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Slack tile missing in Fluxze | Account is not Enterprise | Slack is Enterprise-only |
| Connect → `401`/error | Bad/expired bot token, or bot not installed | Reinstall the app, re-copy `xoxb-…` |
| Event URL won't verify | Wrong `SLACK_SIGNING_SECRET`, or secret unset (`503`) | Set the secret = the app's Signing Secret, redeploy |
| Events verify but nothing arrives | Channel not **linked**, or bot not in the channel | Link the channel (Part 1) + `/invite @Fluxze` |
| New messages still need Import | Event Subscriptions off / `message.channels` not subscribed | Enable it and reinstall |
| Webhook → `405` | nginx not routing `/webhooks/` | Admin: nginx must proxy `/webhooks/` to the backend |

---

## Security notes

- **Bot token** — encrypted at rest in Fluxze; if it leaks, rotate it in the
  Slack app and reconnect.
- **Signing secret** — only authenticates inbound events. To rotate, update both
  the Slack app (it regenerates) and `SLACK_SIGNING_SECRET` on the server.
- Inbound/outbound Slack content is **server-readable** (Enterprise standard
  encryption), which is what makes the bridge possible. Personal/Business
  (E2E) orgs cannot use Slack.
