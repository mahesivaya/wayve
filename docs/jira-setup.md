# Jira setup for Fluxze

How to connect your Jira to Fluxze so your Jira issues show up as **Tasks**, and
changes you make in Jira sync back to those tasks automatically.

The integration has **two independent directions** — set up whichever you need
(most people want both):

| Direction | What it does | What you need |
|---|---|---|
| **Connect / Import** — Fluxze → Jira | Pull the issues assigned to you into Fluxze **Tasks** | a Jira **API token** |
| **Webhook / Live sync** — Jira → Fluxze | When an imported issue changes in Jira, update the linked Task in Fluxze | a **webhook secret** |

> Where each value comes from is summarised in [Quick reference](#quick-reference)
> at the bottom.

> ⚠️ **The two directions are independent — don't confuse them.** The
> **“Jira — Not connected”** badge in the Tasks panel reflects **only the
> Connection (Part 1)**. Setting up the **webhook (Part 2)** does **not** change
> that badge: a working webhook and a “Connected” panel are separate things. The
> badge flips to **Connected** only after you successfully connect with a real
> **API token** in Part 1 — the webhook secret is *not* an API token and will not
> connect the panel.

---

## Part 1 — Connect Jira (import issues into Tasks)

This is the **Fluxze → Jira** direction. You give Fluxze a read API token; Fluxze
pulls your issues in.

### 1. Create a Jira API token

1. Go to **https://id.atlassian.com/manage-profile/security/api-tokens**
   (Atlassian account → **Security** → **API tokens**).
2. Click **Create API token**, give it a label (e.g. `fluxze`), and **Create**.
3. **Copy the token now** — Atlassian shows it only once.

> ⚠️ A real Atlassian API token starts with **`ATATT3x…`** and is **~190
> characters** long. A short 16–20 character string is **not** an API token (it
> will be rejected with `401`). Jira Cloud (`*.atlassian.net`) does **not**
> accept your account password — only an API token.

### 2. Collect your three values

| Value | Where to find it | Example |
|---|---|---|
| **Site URL** | Your Jira address in the browser | `https://your-company.atlassian.net` |
| **Email** | The Atlassian account email the token belongs to | `you@example.com` |
| **API token** | From step 1 | `ATATT3xFfGF0…` |

> Use only the site root for the Site URL (`https://your-company.atlassian.net`)
> — **not** a path like `/jira/...` or `/webhooks/...`.

### 3. Connect in Fluxze

1. In Fluxze, open **Tasks** and find the **Jira** panel.
2. Enter the **Site URL**, **Email**, and **API token** from step 2.
3. Click **Connect**.
   - ✅ Success → the panel shows **Connected**. (Your token is encrypted at rest;
     Fluxze never shows it again.)
   - ❌ `Request failed (401)` → the email/token pair was rejected by Jira. Double
     check the token is a full `ATATT3x…` value and matches the email.

### 4. Import your issues

In the Jira panel, click **Import**. Fluxze pulls the issues assigned to you and
creates a Task for each, linked back to the Jira issue (you'll see a Jira badge on
the task). Re-importing updates existing tasks in place instead of duplicating.

You're done with Part 1 — your Jira issues are now Tasks.

---

## Part 2 — Live sync via webhook (Jira → Fluxze)

This is the **Jira → Fluxze** direction. When an imported issue changes in Jira,
Jira calls a Fluxze URL and the linked Task updates automatically.

Authentication is a **shared secret** (a password you pick) that must be
**identical in two places**: the Fluxze server, and the webhook URL in Jira.

### 1. Choose a webhook secret

It can be any strong random string — it is **not** obtained from Jira or Atlassian,
you invent it. Generate one:

```bash
openssl rand -hex 24
```

Call the result `<YOUR_WEBHOOK_SECRET>` below.

### 2. Set the secret on the Fluxze server (admin step)

A Fluxze administrator sets `JIRA_WEBHOOK_SECRET` to your secret on the server and
restarts the backend so it picks it up:

```bash
# on the Fluxze host
cd /home/ubuntu/rwayve
sed -i '/^JIRA_WEBHOOK_SECRET=/d' backend/.env.production
echo 'JIRA_WEBHOOK_SECRET=<YOUR_WEBHOOK_SECRET>' >> backend/.env.production
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production \
  up -d --no-build --force-recreate backend
```

> If `JIRA_WEBHOOK_SECRET` is **not** set, the webhook endpoint returns `503`
> (“Jira webhook not configured”) and refuses all deliveries.

### 3. Create the webhook in Jira

1. In Jira, go to **Settings (⚙) → System → Webhooks → Create a webhook**.
2. Fill the form:

   | Field | Value |
   |---|---|
   | **Name** | anything, e.g. `fluxze_jira_sync` |
   | **Status** | **Enabled** |
   | **URL** | `https://fluxze.com/webhooks/fluxze_webhook?token=<YOUR_WEBHOOK_SECRET>` |
   | **Secret** | **Leave blank** (see note below) |
   | **Events** | Under **Issue**, tick **created**, **updated**, **deleted** |

3. Save.

> **Why leave the Secret field blank?** Jira's *Secret* field is for **HMAC
> signing** of the request body. Fluxze does **not** verify HMAC — it
> authenticates from the **`?token=` value in the URL**. So the token must be in
> the **URL**; the Secret field is ignored. Putting the secret *only* in the
> Secret field (and not the URL) would fail with `401`.
>
> The URL host must be **`fluxze.com`** (the Fluxze server), **not** your
> `*.atlassian.net` address.

### 4. Verify it works

Quick connectivity check (replace the secret):

```bash
curl -i -X POST \
  "https://fluxze.com/webhooks/fluxze_webhook?token=<YOUR_WEBHOOK_SECRET>" \
  -H 'Content-Type: application/json' \
  -d '{"webhookEvent":"jira:issue_updated"}'
# Expect: HTTP 200  {"ok":true,"ignored":true}
# 401 = token doesn't match the server secret · 503 = secret not set on server
```

Real end-to-end test: edit an issue in Jira that you **imported in Part 1** → the
linked Task in Fluxze updates within seconds. Jira's webhook page shows a per
delivery status, and Fluxze responds `200` with `{"ok":true,"updated":1}`.

> `{"ok":true,"updated":0}` means the delivery worked but **no Task is linked to
> that issue yet** — import the issue (Part 1) first.

---

## Quick reference

| Value | Used for | Where you get it | Example / format |
|---|---|---|---|
| **Site URL** | Connect | Your Jira browser address | `https://your-company.atlassian.net` |
| **Email** | Connect | Your Atlassian account email | `you@example.com` |
| **API token** | Connect | id.atlassian.com → Security → API tokens | `ATATT3x…` (~190 chars) |
| **Webhook secret** | Webhook | You generate it (`openssl rand -hex 24`) | any strong random string |
| **Webhook URL** | Webhook | Fixed Fluxze endpoint + your secret | `https://fluxze.com/webhooks/fluxze_webhook?token=<secret>` |

The **webhook secret** lives in exactly two places and they must match:
`JIRA_WEBHOOK_SECRET` on the server **=** the `?token=` in the Jira webhook URL.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Connect → `401` | API token invalid / not a real token / wrong email | Use a full `ATATT3x…` token that matches the email |
| Connect → `500` | Server is missing the Jira DB tables | Admin: redeploy (boot migrations create them) |
| Webhook → `401` | `?token=` ≠ server `JIRA_WEBHOOK_SECRET` | Make the URL token and the server secret identical |
| Webhook → `503` | `JIRA_WEBHOOK_SECRET` not set on the server | Admin: set it (Part 2, step 2) |
| Webhook → `405` | nginx not routing `/webhooks/` | Admin: nginx must proxy `/webhooks/` to the backend |
| Webhook → `200 {"updated":0}` | No Task linked to that issue | Import the issue first (Part 1) |
| Panel still shows **“Not connected”** after the webhook works | Webhook (Part 2) ≠ Connection (Part 1) — they are separate | Complete **Part 1**: connect with a real `ATATT3x…` API token (the webhook secret won't connect the panel) |

---

## Security notes

- **API token** — treat it like a password. It's encrypted at rest in Fluxze and
  never displayed again after connecting. If it leaks, **revoke** it at
  id.atlassian.com and connect with a new one.
- **Webhook secret** — to rotate it, update **both** places (server
  `JIRA_WEBHOOK_SECRET` *and* the `?token=` in the Jira webhook URL); they must
  always match.
- Never paste a token or secret into a shared chat, ticket, or screenshot. If you
  do, rotate it.
