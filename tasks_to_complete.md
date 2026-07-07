# Tasks to Complete

_Summary of outstanding work from the recent platform build._

---

## 1. App-wide font selector — ship to production
- **Merge PR #40** (`feat/platform-app-font`).
- Apply migration `infra/postgres/migrations/2026-07-platform-ui-config.sql` to **rwayve_prod** (additive/idempotent).
- Deploy `main`.
- **Status:** Built + verified on localhost. PR open, not yet merged/deployed. No env or nginx changes needed.

## 2. Per-user GitHub OAuth — finish prod enablement
- In the GitHub console (OAuth App `Ov23li…`), set the **Authorization callback URL** to exactly `https://fluxze.com/github/oauth/callback`.
- Test the "Connect GitHub" flow end-to-end with a personal account.
- **Status:** Code + nginx `/github/` route + env are deployed. Only the console callback URL + a live test remain.

## 3. Gmail Pub/Sub instant email — GCP setup + reconnect (blocked on you)
- Create the GCP Pub/Sub topic `gmail-sync` + a push subscription to `https://fluxze.com/gmail/push?token=<GMAIL_PUSH_SECRET>`.
- Reconnect each Gmail account (the OAuth client swap invalidated the old refresh tokens).
- **Status:** App-side deployed but dormant until GCP wiring + account reconnect.

## 4. AI usage budget — replace the $200 placeholder
- Decide the real monthly-budget source: owner-configurable value in the DB, an env var, or drop the cap entirely.
- **Status:** Deferred. `ai/usage_handler.rs` currently shows a hardcoded `DEFAULT_MONTHLY_LIMIT_CENTS = 20000`.

## 5. Security — rotate secrets shared in chat
- Rotate the **GitHub OAuth client secret** and the **GMAIL_PUSH_SECRET** (both were pasted in plaintext), then update `backend/.env.production` and redeploy.

## 6. Google OAuth verification + CASA (future)
- Verify the Google OAuth app (project `stalwart-camera-501120-b5`) and complete CASA so real Gmail/Workspace users can authorize (currently a 100 test-user cap; Workspace blocked).

---

### Already shipped this cycle (for reference)
- AI **data-access controls** (platform-only email/calendar toggles) — merged + deployed.
- AI **usage metering** (`/api/ai/usage`, real per-turn token/cost) — merged + deployed.
- Per-user **GitHub OAuth** backend + repo view — merged + deployed (see task 2 for the last step).
- `usage_handler` doc corrected to match real metering.
