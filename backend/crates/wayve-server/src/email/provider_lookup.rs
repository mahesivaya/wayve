//! Decides which provider's OAuth to use for an arbitrary email address, for the
//! "Other" branch of the frontend's ProviderPicker. Detection is two-stage: a
//! static map of the major consumer domains, then an MX lookup for unknown
//! domains, which is what catches enterprise customers on their own domain.
//!
//! Unsupported domains return 400 and are logged at warn (target = "email"), so
//! ops get a feed of which providers to wire up next.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, web};
use hickory_resolver::Resolver;
use hickory_resolver::TokioResolver;
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::rr::RData;
use std::time::Duration;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

#[derive(Deserialize)]
pub struct ProviderLookupRequest {
    pub email: String,
}

#[derive(Serialize)]
pub struct ProviderLookupResponse {
    /// Must stay in sync with the `ProviderId` union in
    /// frontend/src/emails/providers.ts, which dispatches on this value.
    pub provider: &'static str,
}

// One resolver per process, so hickory's cache serves repeat lookups without
// hitting the network.
pub(crate) static RESOLVER: Lazy<TokioResolver> = Lazy::new(|| {
    let mut opts = ResolverOpts::default();
    // A slow nameserver must never wedge a user-facing request. With the outer
    // tokio timeout this keeps the whole MX step under roughly 3s worst case.
    opts.timeout = Duration::from_secs(2);
    opts.attempts = 1;
    // Prefer the system resolver, which Docker injects into /etc/resolv.conf.
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
    // `build()` fails only if the DNS plumbing can't initialize, at which point
    // the process cannot service mail lookups at all.
    builder
        .build()
        .unwrap_or_else(|e| panic!("hickory resolver init failed: {e}"))
});

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

    if let Some(provider) = provider_for_known_domain(&domain) {
        info!(
            target: "email",
            user_id, %domain, provider, source = "static",
            "provider lookup matched"
        );
        return Ok(HttpResponse::Ok().json(ProviderLookupResponse { provider }));
    }

    if let Some(provider) = mx_provider(&domain).await {
        info!(
            target: "email",
            user_id, %domain, provider, source = "mx",
            "provider lookup matched"
        );
        return Ok(HttpResponse::Ok().json(ProviderLookupResponse { provider }));
    }

    // Warn, not debug, so unsupported domains show up in dev.log by default.
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

/// Static domain-to-provider map for the major consumer providers. Anything else
/// falls through to the MX lookup or generic IMAP.
pub(crate) fn provider_for_known_domain(domain: &str) -> Option<&'static str> {
    match domain {
        "gmail.com" | "googlemail.com" => Some("gmail"),
        // The non-outlook.com domains are legacy Hotmail and Windows Live
        // aliases, still in use and still routed to Microsoft.
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.co.uk"
        | "hotmail.co.uk" | "live.co.uk" | "passport.com" => Some("outlook"),
        _ => None,
    }
}

/// Classifies a domain by its MX records. `None` on lookup failure (timeout,
/// NXDOMAIN, no MX records) or when no target matches a known provider.
pub(crate) async fn mx_provider(domain: &str) -> Option<&'static str> {
    let lookup_fut = RESOLVER.mx_lookup(domain);
    // The resolver has its own timeout, but a flapping nameserver can still
    // exceed it, so cap end-to-end.
    let lookup = tokio::time::timeout(Duration::from_secs(3), lookup_fut)
        .await
        .ok()?
        .ok()?;

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

/// Classifies MX targets to a provider. `Name::to_ascii()` returns FQDNs with a
/// trailing dot, so matching `*.aspmx.l.google.com.` rather than
/// `*.aspmx.l.google.com` is deliberate.
fn match_mx_targets(targets: &[String]) -> Option<&'static str> {
    // Google Workspace tenants point at aspmx.l.google.com. and its alt1..N
    // siblings, or rarely at a legacy *.googlemail.com. host.
    let google = targets.iter().any(|t| {
        t.ends_with(".aspmx.l.google.com.")
            || t == "aspmx.l.google.com."
            || t.ends_with(".googlemail.com.")
    });
    if google {
        return Some("gmail");
    }

    // Microsoft 365 tenants point at <tenant>-com.mail.protection.outlook.com.
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
