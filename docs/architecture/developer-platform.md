# Developer platform

How other teams integrate **with** Fluxze (Fluxze as the provider), rather than
how Fluxze integrates with them. Three independent capabilities, sharing one
clean, self-serve surface so we never integrate partners one-by-one:

1. **API keys** — service-to-service credentials (pre-existing). See
   [`routes/api_keys.rs`](../../backend/crates/wayve-server/src/routes/api_keys.rs).
2. **Webhooks** — outbound, signed, retried event delivery (pre-existing). See
   [`webhooks/`](../../backend/crates/wayve-server/src/webhooks/).
3. **App registration + OAuth 2.0** — user-consented access ("Connect with
   Fluxze"), documented below.

The three share the same scope catalog and, for API keys / OAuth, the same
credential crypto and request middleware — so a partner's engineers *and* their
no-code users (Zapier/Make, which are just OAuth clients) plug in the same way.

---

## Part A — App registration

A registered third-party integration owned by a user (and their org, if any).
It is the front door for OAuth: it holds the client credentials, redirect URIs,
and the scopes the app may request.

- **Table** `developer_apps` ([init.sql](../../infra/postgres/init.sql)):
  `client_id` (public), `client_secret_hash` + `client_secret_preview` (secret
  shown once, only its SHA-256 hash stored — exactly like `api_keys`),
  `redirect_uris TEXT[]`, `scopes TEXT[]`, owner `user_id`/`organization_id`,
  soft-revoke via `revoked_at`. Access is application-enforced (no RLS), matching
  `api_keys`.
- **Endpoints** ([`routes/developer_apps.rs`](../../backend/crates/wayve-server/src/routes/developer_apps.rs)),
  all gated by the `api_keys:manage` RBAC permission and the same three-way
  owner-scope visibility rule as `api_keys`:
  - `POST /api/developer/apps` — register; returns `client_secret` **once**.
  - `GET /api/developer/apps` — list (scoped to the caller).
  - `PATCH /api/developer/apps/{id}` — edit name/description/redirect_uris/scopes.
  - `POST /api/developer/apps/{id}/rotate-secret` — new secret, shown once.
  - `DELETE /api/developer/apps/{id}` — soft-revoke.
- **Credentials** ([`wayve-security/api_key.rs`](../../backend/crates/wayve-security/src/api_key.rs)):
  `generate_client_id()` → `wv_app_…` (public), `generate_client_secret()` →
  `wv_cs_…` (192-bit, hashed with `hash_api_key`).
- **UI**: [`developer/DeveloperAppsPage.tsx`](../../frontend/src/developer/DeveloperAppsPage.tsx)
  at `/developer-apps`, reached from **Settings → Developers → App registration**.

Validation: scopes must be known and never `*` (third-party apps can't hold
full access); redirect URIs must be `https` (or `http` on localhost for dev).

---

## Part B — OAuth 2.0 provider

Fluxze acts as an OAuth 2.0 **authorization server**. Authorization Code grant,
PKCE-capable. Code: [`oauth_provider.rs`](../../backend/crates/wayve-server/src/oauth_provider.rs).

### Flow

```
third-party app                     Fluxze                         browser/user
      │  redirect browser to  GET /oauth/authorize?client_id&redirect_uri&scope&state[&code_challenge]
      │───────────────────────────────►│
      │                                │ validate client_id + redirect_uri (exact match) + scopes ⊆ app.scopes
      │                                │ identify user via rwayve_auth cookie (else → /login?next=…)
      │                                │ store pending request (10 min)
      │                                │ 302 → FRONTEND_URL/connect?request_id=…
      │                                │◄──────────────────────────────► consent UI (Allow/Deny)
      │                                │  GET/POST /api/oauth/consent/{id}
      │                                │ approve → mint single-use code (60 s)
      │◄── 302 redirect_uri?code&state ─┤
      │  POST /oauth/token (grant_type=authorization_code, code, redirect_uri,
      │        client_id, client_secret | code_verifier)
      │───────────────────────────────►│ consume code (single-use), verify client
      │◄── {access_token, refresh_token, expires_in, scope} ─┤
      │  API calls: Authorization: Bearer wv_oat_…            │
```

### Tables ([init.sql](../../infra/postgres/init.sql))

- `oauth_pending_authorizations` — a validated authorize request held between the
  redirect and the consent decision (~10 min).
- `oauth_auth_codes` — single-use authorization code (~60 s), carrying the PKCE
  challenge; consumed atomically at the token endpoint.
- `oauth_tokens` — issued access (`wv_oat_…`) + refresh (`wv_ort_…`) tokens,
  scoped and expiring (access 1 h, refresh 30 d). Only SHA-256 hashes stored.

### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /oauth/authorize` | `rwayve_auth` cookie | Validate + stash + redirect to consent |
| `GET /api/oauth/consent/{id}` | session | Consent details for the SPA |
| `POST /api/oauth/consent/{id}` | session | Record Allow/Deny; on Allow, mint code |
| `POST /oauth/token` | client_secret / PKCE | Exchange code, or `refresh_token` grant |

### Client authentication at the token endpoint

- **Confidential clients** present `client_secret` (checked against the stored
  hash).
- **Public clients** (PKCE) present a `code_verifier`; the endpoint checks
  `BASE64URL(SHA256(verifier)) == code_challenge` via
  `verify_pkce_s256` ([`api_key.rs`](../../backend/crates/wayve-security/src/api_key.rs),
  RFC 7636). Only `S256` is accepted.

### Token resolution — the key reuse

An OAuth access token authenticates API calls through the **existing API-key
middleware** ([`middleware/api_key.rs`](../../backend/crates/wayve-server/src/middleware/api_key.rs)),
not a parallel one. The middleware now recognizes two credentials:

- `X-API-KEY: …` — a service API key.
- `Authorization: Bearer wv_oat_…` — an OAuth access token (resolved by
  `oauth_provider::resolve_oauth_token`).

Both normalize to an `ApiKeyPrincipal` and are subject to the same
`required_scope(method, path)` gate, so an OAuth token authenticates as its user
— limited to granted scopes — across every handler unchanged. A **session JWT**
has no `wv_oat_` prefix, so it passes straight through to the JWT/cookie path.

### Routing / deployment

- `/oauth/authorize` and `/oauth/token` are backend routes and ride the existing
  `/oauth` → backend proxy (the same path the Gmail OAuth callback uses), so no
  nginx/proxy changes are needed.
- `/connect` (the consent page) is a frontend route served by the SPA fallback;
  it is deliberately **not** under a backend-proxied prefix.
- **Migrations**: the four additive tables (`developer_apps`,
  `oauth_pending_authorizations`, `oauth_auth_codes`, `oauth_tokens`) must be
  applied at deploy (standard additive-migration runbook).

---

## Integrating with Fluxze (for a partner)

1. Register an app in **Settings → Developers → App registration**; note the
   `client_id`, keep the `client_secret` safe, add your `redirect_uri`, and pick
   the scopes you need.
2. Send the user to
   `https://<fluxze-host>/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=notes:read%20chat:write&state=…`
   (optionally `&code_challenge=…&code_challenge_method=S256` for PKCE).
3. On the callback, exchange the `code`:
   `POST /oauth/token` (form-encoded) with `grant_type=authorization_code`,
   `code`, `redirect_uri`, `client_id`, and either `client_secret` or
   `code_verifier`.
4. Call the API with `Authorization: Bearer <access_token>`. Refresh with
   `grant_type=refresh_token`.

### Scopes

The scope catalog is `API_SCOPES` in
[`api_key.rs`](../../backend/crates/wayve-security/src/api_key.rs) (e.g.
`email:read`, `chat:write`, `notes:read`, `scheduler:write`, `drive:read`,
`tasks:write`, `ai:use`, `profile:read`). A route maps to the scope it needs via
`required_scope(method, path)`. Third-party apps may only request scopes they
registered, and never `*`.

---

## Status & next steps

Built: API keys, webhooks, **app registration**, **OAuth 2.0 provider**. Natural
follow-ups: a public API-docs / event-catalog page, refresh-token rotation, and
a token/grant revocation UI ("apps you've authorized").
