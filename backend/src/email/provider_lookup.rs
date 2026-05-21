//! Email-provider lookup for the "Other" branch of the picker in
//! [ProviderPicker](../../../frontend/src/emails/ProviderPicker.tsx).
//!
//! User types an arbitrary email address; we extract the domain and decide
//! whether we currently support OAuth for it. Two-stage detection:
//!
//!   1. **Static map** — the major consumer domains we know map cleanly to
//!      one provider (gmail.com → Google, outlook.com → Microsoft, …).
//!   2. **MX lookup** — for unknown domains, ask DNS. A custom-domain
//!      Google Workspace tenant routes to `*.aspmx.l.google.com.`, a
//!      Microsoft 365 tenant routes to `*.mail.protection.outlook.com.`.
//!      This is what catches enterprise customers on their own domain.
//!
//! Unsupported domains are **logged** (target = "email", level = warn) and
//! returned as 400 so the frontend can surface the error and redirect home.
//! The log line gives ops a feed of unsupported-domain attempts — useful
//! for deciding which providers to wire up next.

use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{HttpRequest, HttpResponse, post, web};
use hickory_resolver::Resolver;
use hickory_resolver::TokioResolver;
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use std::time::Duration;
use tracing::{info, instrument, warn};

#[derive(Deserialize)]
pub struct ProviderLookupRequest {
    pub email: String,
}

#[derive(Serialize)]
pub struct ProviderLookupResponse {
    /// Frontend dispatches on this to call the existing connect-url endpoint.
    /// Values match the `ProviderId` union in
    /// [providers.ts](../../../frontend/src/emails/providers.ts).
    pub provider: &'static str,
}

// One resolver per process. hickory has a built-in cache; reusing the
// resolver lets repeated lookups (e.g. an enterprise re-trying after a typo)
// hit the cache rather than the network.
static RESOLVER: Lazy<TokioResolver> = Lazy::new(|| {
    let mut opts = ResolverOpts::default();
    // Cap the per-query budget — a slow nameserver should never wedge a
    // user-facing request. Combined with the outer tokio::time::timeout
    // we keep the whole MX step under ~3 s in the worst case.
    opts.timeout = Duration::from_secs(2);
    opts.attempts = 1;
    // Prefer the system resolver (`/etc/resolv.conf`); Docker injects one
    // automatically, so this works in dev and in compose without extra
    // config. Falls back to a sensible default if reading the system config
    // fails. The hickory 0.26 API replaced the `TokioAsyncResolver::tokio()`
    // constructor with the builder-via-config pattern below.
    let (cfg, builder_opts) = match hickory_resolver::system_conf::read_system_conf() {
        Ok((cfg, mut sys_opts)) => {
            sys_opts.timeout = opts.timeout;
            sys_opts.attempts = opts.attempts;
            (cfg, sys_opts)
        }
        Err(_) => (ResolverConfig::default(), opts),
    };
    let mut builder = Resolver::builder_with_config(cfg, TokioRuntimeProvider::default());
    *builder.options_mut() = builder_opts;
    // `build()` only fails if the underlying runtime/dns plumbing can't
    // initialize — at that point the process can't service mail lookups at
    // all, so panicking here is as well-defined as any startup failure.
    builder
        .build()
        .unwrap_or_else(|e| panic!("hickory resolver init failed: {e}"))
});

#[post("/email/provider-lookup")]
#[instrument(target = "email", skip(req, body), fields(email = %body.email))]
pub async fn provider_lookup(
    req: HttpRequest,
    body: web::Json<ProviderLookupRequest>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let email = body.email.trim().to_lowercase();
    let domain = match email.split_once('@') {
        Some((local, d)) if !local.is_empty() && !d.is_empty() && d.contains('.') => d.to_string(),
        _ => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Enter a valid email address" })));
        }
    };

    // Stage 1: static map. Cheap, covers the long-tail consumer providers.
    if let Some(provider) = provider_for_known_domain(&domain) {
        info!(
            target: "email",
            user_id, %domain, provider, source = "static",
            "provider lookup matched"
        );
        return Ok(HttpResponse::Ok().json(ProviderLookupResponse { provider }));
    }

    // Stage 2: MX lookup. Catches custom-domain Google Workspace / M365.
    if let Some(provider) = mx_provider(&domain).await {
        info!(
            target: "email",
            user_id, %domain, provider, source = "mx",
            "provider lookup matched"
        );
        return Ok(HttpResponse::Ok().json(ProviderLookupResponse { provider }));
    }

    // Logged at WARN so it shows up in dev.log without enabling debug, and so
    // we can grep for trending unsupported domains to prioritize.
    warn!(
        target: "email",
        user_id, %domain,
        "provider lookup: no OAuth available for this domain"
    );
    Ok(HttpResponse::BadRequest().json(serde_json::json!({
        "message": format!(
            "We don't yet support mailboxes at {domain}. Use Gmail or Outlook for now."
        )
    })))
}

/// Static domain → provider map for the major consumer providers we support.
fn provider_for_known_domain(domain: &str) -> Option<&'static str> {
    match domain {
        // Google consumer + the alias Google still routes for legacy users.
        "gmail.com" | "googlemail.com" => Some("gmail"),
        // Microsoft consumer family (outlook.com is the modern entry point;
        // the rest are legacy Hotmail / Windows Live aliases still in use).
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.co.uk"
        | "hotmail.co.uk" | "live.co.uk" | "passport.com" => Some("outlook"),
        // Yahoo is on the roadmap but the OAuth flow isn't wired up yet —
        // ProviderPicker also renders it as "Coming soon".
        _ => None,
    }
}

/// Ask DNS for the domain's MX records and classify by their target.
/// Returns `None` if the lookup fails (timeout, NXDOMAIN, no MX records) or
/// if no MX target matches a known provider.
async fn mx_provider(domain: &str) -> Option<&'static str> {
    let lookup_fut = RESOLVER.mx_lookup(domain);
    // Belt-and-suspenders: the resolver itself has a timeout, but a flapping
    // nameserver can still take longer than that worst-case. Cap end-to-end.
    let lookup = tokio::time::timeout(Duration::from_secs(3), lookup_fut)
        .await
        .ok()? // outer timeout
        .ok()?; // resolver error (NXDOMAIN, etc.)

    // 0.26's `Lookup` exposes records via `.answers()` instead of the older
    // `Lookup::iter()` shortcut. Each record's rdata may be any RR type, so
    // we filter for `RData::MX` and project to the exchange hostname.
    let targets: Vec<String> = lookup
        .answers()
        .iter()
        .filter_map(|r| match &r.data {
            RData::MX(mx) => Some(mx.exchange.to_ascii().to_lowercase()),
            _ => None,
        })
        .collect();
    if targets.is_empty() {
        return None;
    }
    match_mx_targets(&targets)
}

/// Classify a set of MX record targets to a provider. Pure function (no
/// network), so unit-testable.
///
/// MX `Name::to_ascii()` returns FQDNs with a trailing dot — matching against
/// `*.aspmx.l.google.com.` rather than `*.aspmx.l.google.com` is intentional.
fn match_mx_targets(targets: &[String]) -> Option<&'static str> {
    // Google Workspace tenants point at one of:
    //   aspmx.l.google.com.        (default for new orgs)
    //   alt1.aspmx.l.google.com.   (etc.)
    //   <something>.googlemail.com. (rare legacy)
    let google = targets.iter().any(|t| {
        t.ends_with(".aspmx.l.google.com.")
            || t == "aspmx.l.google.com."
            || t.ends_with(".googlemail.com.")
    });
    if google {
        return Some("gmail");
    }

    // Microsoft 365 tenants point at `<tenant>-com.mail.protection.outlook.com.`.
    let microsoft = targets
        .iter()
        .any(|t| t.ends_with(".mail.protection.outlook.com."));
    if microsoft {
        return Some("outlook");
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_map_handles_consumer_google() {
        assert_eq!(provider_for_known_domain("gmail.com"), Some("gmail"));
        assert_eq!(provider_for_known_domain("googlemail.com"), Some("gmail"));
    }

    #[test]
    fn static_map_handles_microsoft_family() {
        for domain in [
            "outlook.com",
            "hotmail.com",
            "live.com",
            "msn.com",
            "outlook.co.uk",
        ] {
            assert_eq!(
                provider_for_known_domain(domain),
                Some("outlook"),
                "domain {domain}"
            );
        }
    }

    #[test]
    fn static_map_unknown_returns_none() {
        assert_eq!(provider_for_known_domain("acme-corp.com"), None);
        assert_eq!(provider_for_known_domain("yahoo.com"), None);
        assert_eq!(provider_for_known_domain(""), None);
    }

    #[test]
    fn mx_targets_match_google_workspace() {
        let targets = vec![
            "aspmx.l.google.com.".to_string(),
            "alt1.aspmx.l.google.com.".to_string(),
            "alt2.aspmx.l.google.com.".to_string(),
        ];
        assert_eq!(match_mx_targets(&targets), Some("gmail"));
    }

    #[test]
    fn mx_targets_match_microsoft_365() {
        let targets = vec!["acme-com.mail.protection.outlook.com.".to_string()];
        assert_eq!(match_mx_targets(&targets), Some("outlook"));
    }

    #[test]
    fn mx_targets_unrelated_return_none() {
        // Self-hosted, Proton, Fastmail, etc. — we don't support these via
        // OAuth, so they correctly fall through to the unsupported branch.
        let targets = vec![
            "mail.protonmail.ch.".to_string(),
            "mx.fastmail.com.".to_string(),
            "mail.acme-corp.com.".to_string(),
        ];
        assert_eq!(match_mx_targets(&targets), None);
    }

    #[test]
    fn mx_targets_empty_returns_none() {
        let targets: Vec<String> = vec![];
        assert_eq!(match_mx_targets(&targets), None);
    }
}
