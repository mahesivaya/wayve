//! The one place the backend decides a request's client IP, for rate limiting,
//! audit logs, API-key audit, activity logs, and visit analytics.
//!
//! Forwarding headers are client-writable, so they are believed only when the
//! TCP peer is a trusted proxy. Behind one, the client is the right-most
//! `X-Forwarded-For` hop that is not itself a trusted proxy: every hop to its
//! right was appended by infrastructure we trust, everything to its left could
//! have been sent by the client. The `Forwarded` header is ignored (nginx
//! strips it). actix's `realip_remote_addr` takes the *first* forwarded value
//! with no trust check, which let any client pick the IP it was rate-limited
//! and audited as.
//!
//! Trusted proxies come from `TRUSTED_PROXY_CIDRS` (comma-separated CIDRs or
//! bare IPs; `none` trusts nothing). The default trusts loopback and private
//! ranges: prod nginx reaches the backend over the Docker bridge network, and a
//! private peer address can't be forged over TCP from the internet. Set it
//! explicitly if a CDN or load balancer is ever put in front of nginx.

use actix_web::HttpRequest;
use ipnet::IpNet;
use once_cell::sync::Lazy;
use std::net::{IpAddr, SocketAddr};
use tracing::{info, warn};

const DEFAULT_TRUSTED: &[&str] = &[
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
];

static TRUSTED_PROXIES: Lazy<Vec<IpNet>> = Lazy::new(|| {
    let trusted = parse_trusted(std::env::var("TRUSTED_PROXY_CIDRS").ok().as_deref());
    info!(target: "http", trusted = ?trusted, "client IP: trusted proxy networks");
    trusted
});

/// Parse a `TRUSTED_PROXY_CIDRS` value. Unset or blank means the defaults;
/// invalid entries are logged and skipped rather than trusted.
pub fn parse_trusted(raw: Option<&str>) -> Vec<IpNet> {
    let raw = raw.map(str::trim).unwrap_or_default();
    if raw.is_empty() {
        return DEFAULT_TRUSTED
            .iter()
            .filter_map(|c| c.parse().ok())
            .collect();
    }
    if raw.eq_ignore_ascii_case("none") {
        return Vec::new();
    }
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let parsed = entry
                .parse::<IpNet>()
                .ok()
                .or_else(|| entry.parse::<IpAddr>().ok().map(IpNet::from));
            if parsed.is_none() {
                warn!(target: "http", entry, "TRUSTED_PROXY_CIDRS: ignoring invalid entry");
            }
            parsed
        })
        .collect()
}

/// One `X-Forwarded-For` hop: a bare IP, or an IP with a port.
fn parse_hop(hop: &str) -> Option<IpAddr> {
    let hop = hop.trim();
    hop.parse::<IpAddr>()
        .ok()
        .or_else(|| hop.parse::<SocketAddr>().ok().map(|a| a.ip()))
        .map(|ip| ip.to_canonical())
}

/// The client IP for a connection from `peer` carrying `forwarded_for` (all
/// `X-Forwarded-For` values, comma-joined). `None` only without a peer, which
/// happens for in-process test requests.
pub fn resolve(
    peer: Option<IpAddr>,
    forwarded_for: Option<&str>,
    trusted: &[IpNet],
) -> Option<IpAddr> {
    let peer = peer?.to_canonical();
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(&peer) {
        return Some(peer);
    }
    let mut client = peer;
    for hop in forwarded_for.unwrap_or_default().rsplit(',') {
        // Stop at anything unparseable: nothing to its left can be vouched for,
        // so the last hop a trusted proxy recorded stands.
        let Some(ip) = parse_hop(hop) else { break };
        client = ip;
        if !is_trusted(&ip) {
            break;
        }
    }
    Some(client)
}

/// The request's client IP. See the module docs for the trust rules.
pub fn client_ip(req: &HttpRequest) -> Option<String> {
    let forwarded_for = req
        .headers()
        .get_all("x-forwarded-for")
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(",");
    let forwarded_for = (!forwarded_for.is_empty()).then_some(forwarded_for.as_str());
    resolve(
        req.peer_addr().map(|a| a.ip()),
        forwarded_for,
        &TRUSTED_PROXIES,
    )
    .map(|ip| ip.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap_or_else(|e| panic!("bad test ip {s}: {e}"))
    }

    fn defaults() -> Vec<IpNet> {
        parse_trusted(None)
    }

    #[test]
    fn untrusted_peer_ignores_forwarded_for() {
        let got = resolve(Some(ip("203.0.113.9")), Some("1.2.3.4"), &defaults());
        assert_eq!(
            got,
            Some(ip("203.0.113.9")),
            "a direct client can't pick its IP"
        );
    }

    #[test]
    fn trusted_proxy_yields_the_forwarded_client() {
        // nginx on the Docker bridge, overwriting XFF with the real client.
        let got = resolve(Some(ip("172.18.0.5")), Some("198.51.100.7"), &defaults());
        assert_eq!(got, Some(ip("198.51.100.7")));
    }

    #[test]
    fn spoofed_left_hops_are_skipped() {
        // An appending proxy: the client's forged value sits to the left.
        let got = resolve(
            Some(ip("172.18.0.5")),
            Some("6.6.6.6, 198.51.100.7"),
            &defaults(),
        );
        assert_eq!(got, Some(ip("198.51.100.7")));
    }

    #[test]
    fn chained_trusted_proxies_are_walked_right_to_left() {
        let got = resolve(
            Some(ip("172.18.0.5")),
            Some("6.6.6.6, 198.51.100.7, 10.0.0.2"),
            &defaults(),
        );
        assert_eq!(got, Some(ip("198.51.100.7")));
    }

    #[test]
    fn garbage_hop_stops_the_walk() {
        let got = resolve(
            Some(ip("172.18.0.5")),
            Some("6.6.6.6, not-an-ip"),
            &defaults(),
        );
        assert_eq!(
            got,
            Some(ip("172.18.0.5")),
            "falls back to the last trusted hop"
        );
    }

    #[test]
    fn trusted_peer_without_header_is_the_client() {
        assert_eq!(
            resolve(Some(ip("127.0.0.1")), None, &defaults()),
            Some(ip("127.0.0.1"))
        );
    }

    #[test]
    fn ipv4_mapped_peer_is_canonicalized() {
        let got = resolve(
            Some(ip("::ffff:172.18.0.5")),
            Some("198.51.100.7"),
            &defaults(),
        );
        assert_eq!(got, Some(ip("198.51.100.7")));
    }

    #[test]
    fn hops_with_ports_parse() {
        let got = resolve(Some(ip("10.0.0.1")), Some("[2001:db8::1]:443"), &defaults());
        assert_eq!(got, Some(ip("2001:db8::1")));
    }

    #[test]
    fn trusted_list_parsing() {
        assert!(parse_trusted(Some("none")).is_empty());
        let nets = parse_trusted(Some("10.1.0.0/16, 192.0.2.10, bogus"));
        assert_eq!(nets.len(), 2, "invalid entries are dropped, not trusted");
        assert!(nets.iter().any(|n| n.contains(&ip("192.0.2.10"))));
        // With nothing trusted, even a private peer's header is ignored.
        let got = resolve(Some(ip("172.18.0.5")), Some("198.51.100.7"), &[]);
        assert_eq!(got, Some(ip("172.18.0.5")));
    }
}
