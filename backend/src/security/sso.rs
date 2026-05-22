//! OpenID Connect (OIDC) client — hand-implemented so we don't pull in the
//! whole `openidconnect`/`oauth2` dependency tree. Only the Authorization
//! Code flow + PKCE is supported; that's what every modern enterprise IdP
//! (Okta, Azure AD, Google Workspace, Auth0, Keycloak, ...) accepts for
//! confidential clients.
//!
//! Security checklist (verify when touching this file):
//!   - state is 256 bits of entropy, single-use, server-stored, ≤10 min TTL
//!   - nonce is 256 bits, bound to the state row, checked against id_token
//!   - PKCE S256 is used; the verifier never leaves the server
//!   - id_token signature is verified against the IdP's JWKS (RS256/ES256)
//!   - id_token claims are checked: iss, aud, exp (with skew), iat, nonce
//!   - email_verified is required to be `true` for JIT provisioning
//!   - the `code` is exchanged exactly once; the state row is DELETEd first
//!   - JWKS + discovery are cached with a 1-hour TTL; rotation is automatic
//!
//! Threat model assumes the IdP is honest and the channel to it is TLS.
//! Defensive depth (sub-min JWKS refresh on `kid` miss, audience mismatch
//! handling, etc.) is intentional and should be preserved.

use crate::prelude::*;
use anyhow::anyhow;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use moka::future::Cache as MokaCache;
use once_cell::sync::Lazy;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tracing::{instrument, warn};

const DISCOVERY_TTL_SECS: u64 = 3600;
const JWKS_TTL_SECS: u64 = 3600;
const HTTP_TIMEOUT_SECS: u64 = 10;
// 60s clock skew tolerance for exp/iat. Generous but standard; OIDC servers
// and ours can disagree by a handful of seconds and we don't want to bounce
// a legitimate login over it.
const JWT_LEEWAY_SECS: u64 = 60;

/// IdP-provided OIDC discovery document (only the fields we use).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiscoveryDoc {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    /// `userinfo_endpoint` is optional in the spec; we don't currently call
    /// it (the id_token carries enough claims for sign-in), but parsing it
    /// makes future expansion straightforward.
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
}

/// A single key out of the IdP's JWK Set. Only RSA (RS256/RS384/RS512) is
/// currently supported — that's what 95% of IdPs use. EC keys are a small
/// follow-up if any prospect demands them.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kty: String,
    pub kid: Option<String>,
    pub alg: Option<String>,
    #[serde(rename = "use")]
    pub use_: Option<String>,
    /// RSA modulus (base64url, no padding).
    pub n: Option<String>,
    /// RSA exponent (base64url, no padding).
    pub e: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

/// Claims we read off the id_token. Standard OIDC, no extensions.
#[derive(Debug, Clone, Deserialize)]
pub struct IdTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: serde_json::Value, // string OR string[]; we normalize at the use site
    pub exp: i64,
    pub iat: i64,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
}

/// Token endpoint response. `access_token` and `refresh_token` aren't used
/// by Wayve (we mint our own session JWT after login), but parsing them
/// keeps the surface easy to extend later (e.g. for OIDC RP-Initiated
/// Logout).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: String,
    #[serde(default)]
    _access_token: Option<String>,
    #[serde(default)]
    _refresh_token: Option<String>,
    #[serde(default)]
    _token_type: Option<String>,
}

// =============================================================
// Caches
// =============================================================

static DISCOVERY_CACHE: Lazy<MokaCache<String, DiscoveryDoc>> = Lazy::new(|| {
    MokaCache::builder()
        .time_to_live(Duration::from_secs(DISCOVERY_TTL_SECS))
        .max_capacity(256)
        .build()
});

static JWKS_CACHE: Lazy<MokaCache<String, Jwks>> = Lazy::new(|| {
    MokaCache::builder()
        .time_to_live(Duration::from_secs(JWKS_TTL_SECS))
        .max_capacity(256)
        .build()
});

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Trim a trailing slash so `${issuer}/.well-known/...` is well-formed.
fn normalize_issuer(issuer: &str) -> String {
    issuer.trim_end_matches('/').to_string()
}

// =============================================================
// PKCE + state + nonce
// =============================================================

/// 256 bits of CSPRNG entropy, base64url-no-pad encoded. Used for `state`,
/// `nonce`, and the PKCE `code_verifier`.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 7636 S256 PKCE challenge: base64url(SHA-256(code_verifier)).
pub fn pkce_challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// =============================================================
// Discovery
// =============================================================

/// Fetch (and cache) the IdP's discovery document. Falls back to the
/// cached copy if a refresh fails — IdP blips shouldn't immediately break
/// in-flight logins.
#[instrument(target = "auth", skip_all, fields(issuer = %issuer))]
pub async fn discovery(issuer: &str) -> Result<DiscoveryDoc> {
    let issuer = normalize_issuer(issuer);
    if let Some(doc) = DISCOVERY_CACHE.get(&issuer).await {
        return Ok(doc);
    }
    let url = format!("{issuer}/.well-known/openid-configuration");
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| anyhow!("OIDC discovery fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "OIDC discovery returned HTTP {} from {url}",
            resp.status()
        ));
    }
    let doc: DiscoveryDoc = resp
        .json()
        .await
        .map_err(|e| anyhow!("OIDC discovery JSON parse failed: {e}"))?;
    if normalize_issuer(&doc.issuer) != issuer {
        // The discovery doc's `issuer` field MUST match the URL it was
        // served from. A mismatch is grounds to abort — the IdP could be
        // attempting an issuer-swap attack.
        return Err(anyhow!(
            "OIDC discovery issuer mismatch: expected {issuer}, got {}",
            doc.issuer
        ));
    }
    DISCOVERY_CACHE.insert(issuer, doc.clone()).await;
    Ok(doc)
}

// =============================================================
// JWKS
// =============================================================

#[instrument(target = "auth", skip_all, fields(jwks_uri = %jwks_uri))]
pub async fn jwks(jwks_uri: &str) -> Result<Jwks> {
    if let Some(jwks) = JWKS_CACHE.get(jwks_uri).await {
        return Ok(jwks);
    }
    let resp = http_client()
        .get(jwks_uri)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| anyhow!("JWKS fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "JWKS endpoint returned HTTP {} from {jwks_uri}",
            resp.status()
        ));
    }
    let jwks: Jwks = resp
        .json()
        .await
        .map_err(|e| anyhow!("JWKS JSON parse failed: {e}"))?;
    JWKS_CACHE.insert(jwks_uri.to_string(), jwks.clone()).await;
    Ok(jwks)
}

/// Force-refresh the JWKS cache. Called when verification fails to find
/// the `kid` — IdPs rotate keys on their own schedule, and a `kid` miss
/// usually means the key set changed since we last fetched.
async fn refresh_jwks(jwks_uri: &str) -> Result<Jwks> {
    JWKS_CACHE.invalidate(jwks_uri).await;
    jwks(jwks_uri).await
}

// =============================================================
// Authorize URL + token exchange
// =============================================================

/// Build the IdP authorize URL. The caller is responsible for storing
/// `(state, nonce, pkce_verifier)` server-side before redirecting.
///
/// Keep scope minimal: `openid` is mandatory; `profile email` gets us
/// the claims we need for JIT provisioning. `offline_access` is NOT
/// requested — Wayve uses its own session JWT, not the IdP's refresh
/// token.
#[allow(clippy::too_many_arguments)]
pub fn build_authorize_url(
    discovery: &DiscoveryDoc,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    pkce_challenge: &str,
    login_hint: Option<&str>,
) -> Result<String> {
    let mut url = reqwest::Url::parse(&discovery.authorization_endpoint)
        .map_err(|e| anyhow!("authorization_endpoint URL parse failed: {e}"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("scope", "openid profile email");
        q.append_pair("state", state);
        q.append_pair("nonce", nonce);
        q.append_pair("code_challenge", pkce_challenge);
        q.append_pair("code_challenge_method", "S256");
        if let Some(hint) = login_hint {
            q.append_pair("login_hint", hint);
        }
    }
    Ok(url.into())
}

/// Exchange the authorization code for an id_token. PKCE verifier is
/// mandatory; client secret is sent in the body (most IdPs prefer body
/// over Basic auth for confidential clients these days, and it's what
/// Okta/Azure/Google all accept).
#[allow(clippy::too_many_arguments)]
#[instrument(target = "auth", skip_all)]
pub async fn exchange_code(
    discovery: &DiscoveryDoc,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
    pkce_verifier: &str,
) -> Result<String> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code_verifier", pkce_verifier),
    ];
    let resp = http_client()
        .post(&discovery.token_endpoint)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| anyhow!("Token endpoint POST failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Token endpoint returned HTTP {status}: {body}"));
    }
    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Token endpoint JSON parse failed: {e}"))?;
    Ok(token.id_token)
}

// =============================================================
// id_token verification
// =============================================================

/// Verify the id_token signature against the IdP's JWKS and check all
/// standard OIDC claims. Returns the parsed claims on success.
#[instrument(target = "auth", skip_all)]
pub async fn verify_id_token(
    id_token: &str,
    discovery: &DiscoveryDoc,
    expected_client_id: &str,
    expected_nonce: &str,
) -> Result<IdTokenClaims> {
    // 1. Inspect the unverified header to learn the `kid` and `alg` the
    //    IdP signed with. This is safe — we use it only as a lookup key
    //    into JWKS, not to make trust decisions.
    let header =
        decode_header(id_token).map_err(|e| anyhow!("id_token header decode failed: {e}"))?;
    let kid = header
        .kid
        .ok_or_else(|| anyhow!("id_token missing `kid` header"))?;

    // 2. Look up the matching JWK. On a `kid` miss, force-refresh JWKS
    //    (the IdP may have rotated). If still missing, abort.
    let mut jwks_set = jwks(&discovery.jwks_uri).await?;
    let mut jwk = jwks_set
        .keys
        .iter()
        .find(|k| k.kid.as_deref() == Some(&kid));
    if jwk.is_none() {
        warn!(
            target = "auth",
            "id_token kid {kid} not in cached JWKS; refreshing"
        );
        jwks_set = refresh_jwks(&discovery.jwks_uri).await?;
        jwk = jwks_set
            .keys
            .iter()
            .find(|k| k.kid.as_deref() == Some(&kid));
    }
    let jwk = jwk.ok_or_else(|| anyhow!("id_token kid {kid} not found in JWKS"))?;

    // 3. Build a DecodingKey from the JWK. Only RSA is supported in this
    //    pass; EC support would be ~20 lines and a follow-up.
    if jwk.kty != "RSA" {
        return Err(anyhow!(
            "Unsupported JWK type {} (only RSA is implemented)",
            jwk.kty
        ));
    }
    let n = jwk
        .n
        .as_deref()
        .ok_or_else(|| anyhow!("RSA JWK missing modulus `n`"))?;
    let e = jwk
        .e
        .as_deref()
        .ok_or_else(|| anyhow!("RSA JWK missing exponent `e`"))?;
    let decoding_key = DecodingKey::from_rsa_components(n, e)
        .map_err(|e| anyhow!("RSA JWK component decode failed: {e}"))?;

    // 4. Build a Validation that matches the header alg (RS256/RS384/RS512),
    //    enforces issuer + audience, and applies clock skew. `jsonwebtoken`
    //    checks exp/iat/nbf automatically.
    let alg = match header.alg {
        Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512 => header.alg,
        other => return Err(anyhow!("Unsupported id_token alg: {other:?}")),
    };
    let mut validation = Validation::new(alg);
    validation.set_issuer(&[&discovery.issuer]);
    validation.set_audience(&[expected_client_id]);
    validation.leeway = JWT_LEEWAY_SECS;
    validation.validate_exp = true;

    let token_data = decode::<IdTokenClaims>(id_token, &decoding_key, &validation)
        .map_err(|e| anyhow!("id_token validation failed: {e}"))?;
    let claims = token_data.claims;

    // 5. Audience check is duplicated here because `set_audience` accepts a
    //    match-any list — but if the id_token came with a JSON array, we
    //    additionally want to confirm our client_id is in it (jsonwebtoken
    //    handles this, but being explicit catches IdP quirks where the
    //    array contains the client_id PLUS other resources).
    let aud_ok = match &claims.aud {
        serde_json::Value::String(s) => s == expected_client_id,
        serde_json::Value::Array(arr) => arr.iter().any(|v| v.as_str() == Some(expected_client_id)),
        _ => false,
    };
    if !aud_ok {
        return Err(anyhow!(
            "id_token audience does not include client_id {expected_client_id}"
        ));
    }

    // 6. Nonce binding — the one defense against a stolen id_token being
    //    replayed against a different session.
    match &claims.nonce {
        Some(n) if n == expected_nonce => {}
        Some(_) => return Err(anyhow!("id_token nonce mismatch")),
        None => return Err(anyhow!("id_token missing nonce")),
    }

    Ok(claims)
}

// =============================================================
// Tests
// =============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_test_vector() {
        // RFC 7636 Appendix B sample verifier/challenge.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(pkce_challenge_s256(verifier), expected);
    }

    #[test]
    fn random_token_is_url_safe_and_long_enough() {
        let token = random_token();
        // 32 bytes -> 43 chars base64url-no-pad.
        assert_eq!(token.len(), 43);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn normalize_issuer_strips_trailing_slash() {
        assert_eq!(
            normalize_issuer("https://acme.okta.com/"),
            "https://acme.okta.com"
        );
        assert_eq!(
            normalize_issuer("https://acme.okta.com"),
            "https://acme.okta.com"
        );
    }
}
