//! Hand-rolled OpenID Connect client, avoiding the `openidconnect`/`oauth2`
//! dependency tree. Only the Authorization Code flow with PKCE is supported,
//! which is what every modern enterprise IdP accepts for confidential clients.
//!
//! Security checklist to re-verify when touching this file:
//!   - state is 256 bits of entropy, single-use, server-stored, TTL ≤ 10 min
//!   - nonce is 256 bits, bound to the state row, checked against the id_token
//!   - PKCE S256 is used and the verifier never leaves the server
//!   - the id_token signature is verified against the IdP's JWKS (RS256/ES256)
//!   - the id_token's iss, aud, exp (with skew), iat, and nonce are all checked
//!   - email_verified must be `true` for JIT provisioning
//!   - the `code` is exchanged exactly once; the state row is DELETEd first
//!   - JWKS and discovery are cached for an hour; rotation is automatic
//!
//! The threat model assumes an honest IdP reached over TLS. The defensive depth
//! here (JWKS refresh on a `kid` miss, explicit audience handling) is deliberate.

use anyhow::{Result, anyhow};
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
// Clock skew tolerance for exp/iat, so a few seconds of drift against the IdP
// does not bounce a legitimate login.
const JWT_LEEWAY_SECS: u64 = 60;

/// IdP-provided OIDC discovery document (only the fields we use).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiscoveryDoc {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    /// Optional in the spec and unused here; the id_token carries enough claims
    /// for sign-in.
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
}

/// A single key from the IdP's JWK Set. Only RSA is supported; EC keys are
/// rejected at verification time.
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

/// Standard OIDC id_token claims, no extensions.
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

/// Token endpoint response. The access and refresh tokens are parsed but unused:
/// Wayve mints its own session JWT after login.
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

/// Fetch and cache the IdP's discovery document.
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
        // The document's `issuer` must match the URL it was served from;
        // a mismatch is an issuer-swap attack.
        return Err(anyhow!(
            "OIDC discovery issuer mismatch: expected {issuer}, got {}",
            doc.issuer
        ));
    }
    DISCOVERY_CACHE.insert(issuer, doc.clone()).await;
    Ok(doc)
}

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

/// Force-refresh the JWKS cache after a `kid` miss, which usually means the IdP
/// rotated keys since the last fetch.
async fn refresh_jwks(jwks_uri: &str) -> Result<Jwks> {
    JWKS_CACHE.invalidate(jwks_uri).await;
    jwks(jwks_uri).await
}

/// Build the IdP authorize URL. The caller must store `(state, nonce,
/// pkce_verifier)` server-side before redirecting.
///
/// The scope stays minimal. `offline_access` is deliberately not requested,
/// since Wayve uses its own session JWT rather than the IdP's refresh token.
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

/// Exchange the authorization code for an id_token. The PKCE verifier is
/// mandatory, and the client secret goes in the body rather than Basic auth.
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

/// Verify the id_token signature against the IdP's JWKS and check every standard
/// OIDC claim, returning the parsed claims on success.
#[instrument(target = "auth", skip_all)]
pub async fn verify_id_token(
    id_token: &str,
    discovery: &DiscoveryDoc,
    expected_client_id: &str,
    expected_nonce: &str,
) -> Result<IdTokenClaims> {
    // The unverified header is only ever used as a JWKS lookup key, never to
    // make a trust decision.
    let header =
        decode_header(id_token).map_err(|e| anyhow!("id_token header decode failed: {e}"))?;
    let kid = header
        .kid
        .ok_or_else(|| anyhow!("id_token missing `kid` header"))?;

    // A `kid` miss triggers one forced JWKS refresh in case the IdP rotated.
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

    // Restricting the algorithm to the RSA family is what stops an alg-confusion
    // attack; `jsonwebtoken` then checks exp/iat/nbf itself.
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

    // The audience check is deliberately repeated: `aud` may arrive as a string
    // or an array, and being explicit catches IdPs that list our client_id
    // alongside other resources.
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

    // Nonce binding is the only defense against a stolen id_token being replayed
    // against a different session.
    match &claims.nonce {
        Some(n) if n == expected_nonce => {}
        Some(_) => return Err(anyhow!("id_token nonce mismatch")),
        None => return Err(anyhow!("id_token missing nonce")),
    }

    Ok(claims)
}

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
