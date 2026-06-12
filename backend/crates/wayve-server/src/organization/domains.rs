//! Organization custom-domain ownership.
//!
//! Endpoints under `/api/organizations/{org_id}/domains`:
//!
//! - `GET /domains` — list the org's claimed domains + status.
//! - `POST /domains` — claim a domain (returns the DNS TXT challenge to publish).
//! - `POST /domains/{id}/verify` — run the DNS TXT check; flip `verified`.
//! - `DELETE /domains/{id}` — drop a claim.
//!
//! All four are **platform-owner only** — the platform owner administers
//! which domains an organization is allowed to mint addresses on. Ownership
//! is proven by DNS, not asserted: `verified` is only ever set by
//! [`verify_domain`] after a successful TXT lookup, never from a client field.
//!
//! The single source of truth for "may this org mint `x@domain`?" is
//! [`is_domain_verified_for_org`], consumed by `admin_create_user`.

use crate::email::provider_lookup::RESOLVER;
use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, delete, get, post, put, web};
use chrono::{DateTime, Utc};
use hickory_resolver::proto::rr::RData;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::time::Duration;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{Role, Scope, resolve_role_context};

/// Free / public email providers can never be claimed as an organization
/// domain — nobody can prove DNS control of a shared consumer domain, and
/// they're not anyone's private domain. Rejected before the DNS step.
const PUBLIC_PROVIDER_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "fastmail.com",
    "hey.com",
    "usa.com",
];

/// True if `domain` is a known public/free email provider (case-insensitive).
pub fn is_public_provider_domain(domain: &str) -> bool {
    let d = domain.trim().to_lowercase();
    PUBLIC_PROVIDER_DOMAINS.contains(&d.as_str())
}

/// Normalize user-typed input into a bare registrable domain, or `None` if it
/// doesn't look like a domain. Strips scheme/path, lowercases, trims a
/// trailing dot, and rejects anything with illegal characters or shape.
pub fn normalize_domain(input: &str) -> Option<String> {
    let mut d = input.trim().to_lowercase();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = d.strip_prefix(prefix) {
            d = rest.to_string();
        }
    }
    if let Some(idx) = d.find('/') {
        d.truncate(idx);
    }
    if let Some(idx) = d.find('@') {
        // tolerate someone pasting an email address
        d = d[idx + 1..].to_string();
    }
    let d = d.trim_end_matches('.').to_string();
    if d.is_empty() || !d.contains('.') || d.len() > 253 {
        return None;
    }
    if d.starts_with('.')
        || d.starts_with('-')
        || d.ends_with('-')
        || d.contains("..")
        || d.contains(".-")
        || d.contains("-.")
    {
        return None;
    }
    if !d
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    Some(d)
}

/// 32-char alphanumeric challenge token. High entropy so it can't be guessed
/// and forged into a TXT record by anyone other than the domain's DNS admin.
fn generate_verify_token() -> String {
    use rand::{Rng, distributions::Alphanumeric};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// The DNS record name + value the claimant must publish to prove control.
fn challenge_record(domain: &str, token: &str) -> (String, String) {
    (
        format!("_wayve-challenge.{domain}"),
        format!("wayve-verify={token}"),
    )
}

// ---------------------------------------------------------------------------
//   Platform-owner gate
// ---------------------------------------------------------------------------

/// Require the caller to be the platform **owner**. Domain administration is
/// a platform-team responsibility, restricted to the owner role.
async fn require_platform_owner(req: &HttpRequest, pool: &PgPool) -> Result<i32, HttpResponse> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(HttpResponse::Unauthorized()
            .json(serde_json::json!({ "message": "Authentication required" })));
    };
    let ctx = resolve_role_context(pool, user_id).await.map_err(|e| {
        warn!(target: "auth", user_id, error = ?e, "domain admin rbac resolution failed");
        HttpResponse::InternalServerError().finish()
    })?;
    if ctx.scope != Scope::Platform || ctx.role != Role::Owner {
        warn!(target: "auth", user_id, role = ctx.role.as_str(), "domain admin denied: not platform owner");
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Domain administration is restricted to the platform owner"
        })));
    }
    Ok(user_id)
}

// ---------------------------------------------------------------------------
//   Request / response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ClaimDomainRequest {
    pub domain: String,
}

#[derive(Debug, Serialize)]
pub struct DomainView {
    pub id: i32,
    pub organization_id: i32,
    pub domain: String,
    pub verified: bool,
    pub verified_at: Option<DateTime<Utc>>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// DNS record the org must publish (present while unverified).
    pub txt_name: Option<String>,
    pub txt_value: Option<String>,
}

fn to_view(r: &sqlx::postgres::PgRow) -> DomainView {
    let domain: String = r.get("domain");
    let verify_token: String = r.get("verify_token");
    let verified: bool = r.get("verified");
    let (txt_name, txt_value) = if verified {
        (None, None)
    } else {
        let (name, value) = challenge_record(&domain, &verify_token);
        (Some(name), Some(value))
    };
    DomainView {
        id: r.get("id"),
        organization_id: r.get("organization_id"),
        domain,
        verified,
        verified_at: r.get("verified_at"),
        last_checked_at: r.get("last_checked_at"),
        created_at: r.get("created_at"),
        txt_name,
        txt_value,
    }
}

// ---------------------------------------------------------------------------
//   Handlers
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/domains")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn list_domains(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let org_id = path.into_inner();

    let rows = sqlx::query(
        "SELECT id, organization_id, domain, verify_token, verified, \
                verified_at, last_checked_at, created_at \
         FROM organization_domains WHERE organization_id = $1 ORDER BY created_at",
    )
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await?;

    let views: Vec<DomainView> = rows.iter().map(to_view).collect();

    Ok(HttpResponse::Ok().json(views))
}

#[post("/organizations/{org_id}/domains")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn claim_domain(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<ClaimDomainRequest>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let org_id = path.into_inner();

    let Some(domain) = normalize_domain(&body.domain) else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "That doesn't look like a valid domain" })));
    };
    if is_public_provider_domain(&domain) {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": format!("'{domain}' is a public email provider and can't be claimed as an organization domain")
        })));
    }

    let token = generate_verify_token();
    let row = sqlx::query(
        "INSERT INTO organization_domains (organization_id, domain, verify_token) \
         VALUES ($1, $2, $3) \
         RETURNING id, organization_id, domain, verify_token, verified, \
                   verified_at, last_checked_at, created_at",
    )
    .bind(org_id)
    .bind(&domain)
    .bind(&token)
    .fetch_one(pool.get_ref())
    .await;

    match row {
        Ok(r) => {
            info!(target: "auth", org_id, %domain, "organization domain claimed");
            Ok(HttpResponse::Created().json(to_view(&r)))
        }
        Err(e) if e.to_string().contains("duplicate key") => {
            Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": format!("'{domain}' has already been claimed")
            })))
        }
        Err(e) => Err(AppError::Db(e)),
    }
}

#[derive(Deserialize)]
pub struct DomainPolicyInput {
    pub allow: bool,
}

/// Read the org's "allow unverified/public email domains" flag. Platform-owner only.
#[get("/organizations/{org_id}/domain-policy")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn get_domain_policy(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let org_id = path.into_inner();
    let allow: bool = sqlx::query_scalar::<_, bool>(
        "SELECT allow_unverified_email_domains FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await?
    .unwrap_or(false);
    Ok(HttpResponse::Ok().json(serde_json::json!({ "allow_unverified_email_domains": allow })))
}

/// Toggle the org's "allow unverified/public email domains" flag. When true,
/// `admin_create_user` skips the public-provider + verified-domain checks for
/// this org, letting it mint addresses on any domain. Platform-owner only.
#[put("/organizations/{org_id}/domain-policy")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn set_domain_policy(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<DomainPolicyInput>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let org_id = path.into_inner();
    let updated =
        sqlx::query("UPDATE organizations SET allow_unverified_email_domains = $1 WHERE id = $2")
            .bind(body.allow)
            .bind(org_id)
            .execute(pool.get_ref())
            .await?;
    if updated.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Organization not found" })));
    }
    info!(target: "auth", org_id, allow = body.allow, "organization domain policy updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "allow_unverified_email_domains": body.allow })))
}

#[post("/organizations/{org_id}/domains/{domain_id}/verify")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn verify_domain(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let (org_id, domain_id) = path.into_inner();

    let Some(row) = sqlx::query(
        "SELECT domain, verify_token FROM organization_domains \
         WHERE id = $1 AND organization_id = $2",
    )
    .bind(domain_id)
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await?
    else {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Domain not found" }))
        );
    };
    let domain: String = row.get("domain");
    let token: String = row.get("verify_token");

    let ok = dns_txt_contains(&domain, &format!("wayve-verify={token}")).await;

    // Always stamp last_checked_at; flip verified only on success.
    sqlx::query(
        "UPDATE organization_domains \
         SET last_checked_at = NOW(), \
             verified = CASE WHEN $2 THEN TRUE ELSE verified END, \
             verified_at = CASE WHEN $2 AND verified_at IS NULL THEN NOW() ELSE verified_at END \
         WHERE id = $1",
    )
    .bind(domain_id)
    .bind(ok)
    .execute(pool.get_ref())
    .await?;

    if ok {
        info!(target: "auth", org_id, %domain, "organization domain verified");
        Ok(HttpResponse::Ok().json(serde_json::json!({ "verified": true, "domain": domain })))
    } else {
        let (name, value) = challenge_record(&domain, &token);
        Ok(HttpResponse::Ok().json(serde_json::json!({
            "verified": false,
            "domain": domain,
            "message": "TXT record not found yet — DNS can take a few minutes to propagate.",
            "txt_name": name,
            "txt_value": value
        })))
    }
}

#[delete("/organizations/{org_id}/domains/{domain_id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_domain(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    if let Err(resp) = require_platform_owner(&req, pool.get_ref()).await {
        return Ok(resp);
    }
    let (org_id, domain_id) = path.into_inner();
    sqlx::query("DELETE FROM organization_domains WHERE id = $1 AND organization_id = $2")
        .bind(domain_id)
        .bind(org_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

// ---------------------------------------------------------------------------
//   DNS + shared verified-domain check
// ---------------------------------------------------------------------------

/// Look up the TXT records at `_wayve-challenge.<domain>` and return true if
/// any record exactly equals `expected`. A TXT record can be split into
/// multiple character-strings, so chunks are joined before comparison.
async fn dns_txt_contains(domain: &str, expected: &str) -> bool {
    let name = format!("_wayve-challenge.{domain}");
    let lookup = match tokio::time::timeout(Duration::from_secs(5), RESOLVER.txt_lookup(name)).await
    {
        Ok(Ok(lookup)) => lookup,
        _ => return false,
    };
    // 0.26's Lookup exposes records via .answers(); filter for RData::TXT.
    // A TXT record may be split into multiple character-strings, so join the
    // chunks before comparing against the expected challenge value.
    lookup.answers().iter().any(|r| match &r.data {
        RData::TXT(txt) => {
            let joined: Vec<u8> = txt
                .txt_data
                .iter()
                .flat_map(|chunk| chunk.iter().copied())
                .collect();
            String::from_utf8_lossy(&joined).trim() == expected
        }
        _ => false,
    })
}

/// Single source of truth for "may this org mint `*@domain`?" — true only if
/// the org has a VERIFIED claim on exactly this domain. Used by the member-
/// creation gate.
pub async fn is_domain_verified_for_org(pool: &PgPool, org_id: i32, domain: &str) -> bool {
    let normalized = domain.trim().to_lowercase();
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS( \
            SELECT 1 FROM organization_domains \
            WHERE organization_id = $1 AND lower(domain) = $2 AND verified = TRUE \
         )",
    )
    .bind(org_id)
    .bind(&normalized)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}
