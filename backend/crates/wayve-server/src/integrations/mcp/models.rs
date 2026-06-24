use crate::prelude::*;

/// Who owns a set of MCP connections. The feature is limited to the **platform**
/// scope and **enterprise**-tier organizations; personal/business accounts never
/// resolve to an owner (see `handler::require_mcp_owner`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpOwner {
    Organization(i32),
    Platform,
}

impl McpOwner {
    /// `(owner_scope, organization_id)` for binding into the polymorphic
    /// `mcp_connections` rows. Platform rows carry a NULL `organization_id`;
    /// queries match it with `IS NOT DISTINCT FROM` so NULL compares equal.
    pub fn as_columns(self) -> (&'static str, Option<i32>) {
        match self {
            McpOwner::Organization(id) => ("organization", Some(id)),
            McpOwner::Platform => ("platform", None),
        }
    }
}

/// A decrypted MCP connection, ready for a handshake / tool call. Never
/// serialized — it carries the plaintext auth token. Only the fields the agent
/// loop needs are kept (the management list reads rows directly).
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
    /// Bearer token for the server, if it needs one. Validated by handshaking
    /// before storage, then encrypted at rest.
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

/// One tool as advertised by an MCP server's `tools/list`. `input_schema` is
/// full JSON Schema; the agent sanitizes it down to Gemini's accepted subset
/// before declaring it.
#[derive(Deserialize, Clone)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<Value>,
}
