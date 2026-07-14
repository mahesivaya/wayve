use crate::prelude::*;

/// Who owns a set of MCP connections. Limited to the platform scope and
/// enterprise-tier organizations; personal and business accounts never resolve to
/// an owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpOwner {
    Organization(i32),
    Platform,
}

impl McpOwner {
    /// `(owner_scope, organization_id)` for binding into `mcp_connections`.
    /// Platform rows carry a NULL `organization_id`, so queries must match it with
    /// `IS NOT DISTINCT FROM` for NULL to compare equal.
    pub fn as_columns(self) -> (&'static str, Option<i32>) {
        match self {
            McpOwner::Organization(id) => ("organization", Some(id)),
            McpOwner::Platform => ("platform", None),
        }
    }
}

/// A decrypted MCP connection, ready for a handshake or tool call. Must never be
/// serialized: it carries the plaintext auth token.
#[derive(Clone)]
pub struct McpConnection {
    pub label: String,
    pub server_url: String,
    /// Bearer token, or `None` when the server needs no auth.
    pub auth_token: Option<String>,
}

/// Connection state returned to the frontend. Carries no secret.
#[derive(Serialize)]
pub struct ConnectionStatus {
    pub id: i32,
    pub label: String,
    pub server_url: String,
    pub enabled: bool,
    pub server_name: Option<String>,
    pub last_tool_count: Option<i32>,
    pub last_validated_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
pub struct ConnectInput {
    pub label: String,
    /// The remote MCP server's single Streamable-HTTP endpoint (https).
    pub server_url: String,
    /// Bearer token, validated by a handshake before storage and encrypted at rest.
    #[serde(default)]
    pub auth_token: Option<String>,
    /// `bearer` (default) or `none`.
    #[serde(default)]
    pub auth_type: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateInput {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub server_url: Option<String>,
    /// New bearer token. `Some("")` clears it; omitted leaves it unchanged.
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// One tool as advertised by an MCP server's `tools/list`. `input_schema` is full
/// JSON Schema, which the agent sanitizes down to the providers' accepted subset.
#[derive(Deserialize, Clone)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<Value>,
}
