//! Minimal MCP (Model Context Protocol) client over the Streamable-HTTP transport,
//! the only transport usable from a hosted backend. It speaks JSON-RPC 2.0 to a
//! single endpoint.
//!
//! It uses its own HTTP client for SSRF reasons: the server URL is admin-supplied
//! and fetched from inside the VPC, so every call revalidates that it is https and
//! resolves to a publicly routable IP (the EC2 metadata endpoint 169.254.169.254 is
//! the load-bearing block), and redirects are disabled so a 302 cannot bounce past
//! that guard. Residual risk is DNS rebinding between our `lookup_host` and
//! reqwest's own resolution; revalidating on every request shrinks the window.

use crate::prelude::*;
use reqwest::Url;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;
use tracing::warn;

use super::models::McpTool;

const PROTOCOL_VERSION: &str = "2025-06-18";
const RPC_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024; // 1 MiB per JSON-RPC body
const MAX_TOOLS_PAGES: usize = 20;

/// Dedicated outbound client: redirects OFF, tight timeouts.
static MCP_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
});

/// True when `ip` is private or internal and must be refused. `is_link_local`
/// (169.254.0.0/16) covers the cloud metadata endpoint.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 carrier-grade NAT
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            // fc00::/7 unique-local OR fe80::/10 link-local
            (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// SSRF gate: require https and ensure every address the host resolves to is
/// publicly routable. Bypassed only by the test-only `MCP_ALLOW_PRIVATE_HOSTS`.
pub async fn validate_server_url(url: &str) -> Result<(), AppError> {
    // Parse first, so even a bypassed test URL must be well-formed.
    let parsed = Url::parse(url).map_err(|_| AppError::bad_request("Invalid MCP server URL"))?;

    if crate::external::mcp_allow_private_hosts() {
        return Ok(());
    }

    if parsed.scheme() != "https" {
        return Err(AppError::bad_request("MCP server URL must use https"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::bad_request("MCP server URL has no host"))?
        .to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(AppError::bad_request(
            "MCP server URL must be a public host",
        ));
    }
    let port = parsed.port_or_known_default().unwrap_or(443);

    // A hostname must have every resolved address checked, not just the first.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(AppError::bad_request(
                "MCP server URL resolves to a non-public address",
            ));
        }
        return Ok(());
    }

    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| AppError::bad_request("Could not resolve MCP server host"))?;
    let mut resolved_any = false;
    for addr in addrs {
        resolved_any = true;
        if is_blocked_ip(addr.ip()) {
            return Err(AppError::bad_request(
                "MCP server URL resolves to a non-public address",
            ));
        }
    }
    if !resolved_any {
        return Err(AppError::bad_request("Could not resolve MCP server host"));
    }
    Ok(())
}

/// A live MCP session against one server.
pub struct McpClient {
    url: String,
    token: Option<String>,
    session_id: Mutex<Option<String>>,
    initialized: Mutex<bool>,
}

impl McpClient {
    pub fn new(url: &str, token: Option<&str>) -> Self {
        Self {
            url: url.to_string(),
            token: token.map(|t| t.to_string()),
            session_id: Mutex::new(None),
            initialized: Mutex::new(false),
        }
    }

    fn base_request(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut b = builder
            .timeout(RPC_TIMEOUT)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION);
        if let Some(token) = &self.token {
            b = b.bearer_auth(token);
        }
        // The lock must be released before any await, never held across one.
        let sid = self.session_id.lock().ok().and_then(|g| g.clone());
        if let Some(sid) = sid {
            b = b.header("Mcp-Session-Id", sid);
        }
        b
    }

    fn store_session(&self, resp: &reqwest::Response) {
        if let Some(val) = resp.headers().get("mcp-session-id")
            && let Ok(s) = val.to_str()
            && let Ok(mut guard) = self.session_id.lock()
        {
            *guard = Some(s.to_string());
        }
    }

    /// A JSON-RPC request (has an `id`). A JSON-RPC `error` maps to a 400.
    async fn rpc(&self, id: i64, method: &str, params: Value) -> Result<Value, AppError> {
        validate_server_url(&self.url).await?;
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        let resp = self
            .base_request(MCP_HTTP_CLIENT.post(&self.url))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, method, "mcp request transport error");
                AppError::bad_request("Could not reach the MCP server")
            })?;
        self.store_session(&resp);

        let status = resp.status();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let raw = resp.text().await.map_err(|e| {
            warn!(target: "worker", error = ?e, method, "mcp response read error");
            AppError::bad_request("Invalid response from the MCP server")
        })?;
        if raw.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::bad_request("MCP server response too large"));
        }
        if raw.trim().is_empty() {
            return Err(AppError::bad_request(format!(
                "MCP server returned HTTP {} with no body",
                status.as_u16()
            )));
        }

        let envelope: Value = if ctype.contains("text/event-stream") {
            parse_sse_json(&raw)?
        } else {
            serde_json::from_str(&raw)
                .map_err(|_| AppError::bad_request("MCP server returned malformed JSON-RPC"))?
        };

        if let Some(err) = envelope.get("error") {
            let msg = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("error");
            warn!(target: "worker", method, error = %msg, "mcp json-rpc error");
            return Err(AppError::bad_request(format!("MCP server error: {msg}")));
        }
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    }

    /// A JSON-RPC notification (no `id`). The server replies 202 with no body.
    async fn notify(&self, method: &str) -> Result<(), AppError> {
        validate_server_url(&self.url).await?;
        let body = serde_json::json!({ "jsonrpc": "2.0", "method": method });
        self.base_request(MCP_HTTP_CLIENT.post(&self.url))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                warn!(target: "worker", error = ?e, method, "mcp notify transport error");
                AppError::bad_request("Could not reach the MCP server")
            })?;
        Ok(())
    }

    /// `initialize` + `notifications/initialized`. Returns `serverInfo.name`.
    pub async fn initialize(&self) -> Result<Option<String>, AppError> {
        let params = serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "Fluxze", "version": "1.0.0" },
        });
        let result = self.rpc(1, "initialize", params).await?;
        self.notify("notifications/initialized").await?;
        if let Ok(mut g) = self.initialized.lock() {
            *g = true;
        }
        Ok(result
            .get("serverInfo")
            .and_then(|s| s.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_string()))
    }

    /// `tools/list`, following `nextCursor` pagination.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, AppError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for page in 0..MAX_TOOLS_PAGES {
            let params = match &cursor {
                Some(c) => serde_json::json!({ "cursor": c }),
                None => serde_json::json!({}),
            };
            let result = self.rpc(100 + page as i64, "tools/list", params).await?;
            if let Some(arr) = result.get("tools").and_then(|t| t.as_array()) {
                for t in arr {
                    if let Ok(tool) = serde_json::from_value::<McpTool>(t.clone()) {
                        tools.push(tool);
                    }
                }
            }
            cursor = result
                .get("nextCursor")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string());
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    /// `tools/call`, handshaking first if needed. Returns the raw JSON-RPC result.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<Value, AppError> {
        let inited = self.initialized.lock().map(|g| *g).unwrap_or(false);
        if !inited {
            self.initialize().await?;
        }
        let params = serde_json::json!({ "name": name, "arguments": args });
        self.rpc(900, "tools/call", params).await
    }
}

/// A Streamable-HTTP server may answer with SSE. The payload is the last `data:`
/// event that parses as JSON; one event's data may span several `data:` lines.
fn parse_sse_json(raw: &str) -> Result<Value, AppError> {
    let mut last: Option<Value> = None;
    let mut buf = String::new();
    let flush = |buf: &mut String, last: &mut Option<Value>| {
        if !buf.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(buf) {
                *last = Some(v);
            }
            buf.clear();
        }
    };
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(rest);
        } else if line.trim().is_empty() {
            flush(&mut buf, &mut last);
        }
    }
    flush(&mut buf, &mut last);
    last.ok_or_else(|| AppError::bad_request("MCP SSE response had no JSON-RPC payload"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn blocks_metadata_and_private_ips() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_blocked_ip("fd00::1".parse().unwrap()));
        assert!(is_blocked_ip("fe80::1".parse().unwrap()));
        assert!(is_blocked_ip("::ffff:169.254.169.254".parse().unwrap()));
    }

    #[test]
    fn allows_public_ips() {
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(!is_blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_http_and_private_urls() {
        assert!(validate_server_url("http://example.com/mcp").await.is_err());
        assert!(
            validate_server_url("https://169.254.169.254/mcp")
                .await
                .is_err()
        );
        assert!(validate_server_url("https://127.0.0.1/mcp").await.is_err());
        assert!(validate_server_url("ftp://example.com").await.is_err());
        assert!(validate_server_url("not a url").await.is_err());
    }

    #[test]
    fn parses_sse_envelope() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let v = parse_sse_json(body).unwrap();
        assert_eq!(v["result"]["ok"], serde_json::json!(true));
    }
}
