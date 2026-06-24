//! The agentic chat loop. When the caller is an MCP owner (enterprise org or
//! platform) with connected servers, their tools are declared to Gemini as
//! function declarations and a bounded tool-call loop lets the model read the
//! customer's systems through `tools/call`. Everyone else (personal/business,
//! or no connections) gets the plain Gemini passthrough — unchanged behavior.
//!
//! Non-streaming to match the frontend, which awaits a single `{reply}`. The
//! response is extended with an optional `tools_used` list.

use crate::email::oauth::HTTP_CLIENT;
use crate::integrations::mcp::client::McpClient;
use crate::integrations::mcp::handler::{load_connections, resolve_mcp_owner_opt};
use crate::prelude::*;
use std::collections::HashMap;
use tracing::warn;

/// Max tool-calling rounds before we force a final, tool-less answer. Bounds a
/// misbehaving server from trapping the model in an endless call cycle.
const MAX_ROUNDS: usize = 5;
/// Cap on how many tools we declare to Gemini in one request.
const MAX_TOOLS: usize = 64;
/// Cap on a single tool's textual output fed back to the model (chars).
const MAX_TOOL_OUTPUT: usize = 8000;

/// One tool invocation surfaced to the UI (no arguments/output — just what ran).
#[derive(Serialize)]
pub struct ToolUsed {
    pub name: String,
    pub connection_label: String,
}

pub struct ChatResult {
    pub reply: String,
    pub tools_used: Vec<ToolUsed>,
}

/// Live MCP state for one chat: aligned clients/labels, the Gemini tool
/// declarations, and a map from the namespaced tool name back to its owning
/// client + original name.
struct LoadedMcp {
    clients: Vec<McpClient>,
    labels: Vec<String>,
    decls: Vec<Value>,
    dispatch: HashMap<String, (usize, String)>,
}

/// Run a chat turn. `contents` is the already-mapped Gemini conversation.
pub async fn run(
    pool: &PgPool,
    user_id: i32,
    contents: Vec<Value>,
    api_key: &str,
    model: &str,
) -> Result<ChatResult, AppError> {
    let loaded = match load_mcp_tools(pool, user_id).await {
        Some(l) => l,
        None => return passthrough(&contents, api_key, model).await,
    };

    let LoadedMcp {
        clients,
        labels,
        decls,
        dispatch,
    } = loaded;

    let mut contents = contents;
    let mut tools_used: Vec<ToolUsed> = Vec::new();

    for _round in 0..MAX_ROUNDS {
        let content = gemini_generate(&contents, &decls, api_key, model).await?;
        let parts = content_parts(&content);
        let has_call = parts.iter().any(|p| p.get("functionCall").is_some());
        if !has_call {
            return Ok(ChatResult {
                reply: stitch_text(&parts),
                tools_used,
            });
        }

        // Echo the model's turn (it carries the functionCall parts), then answer
        // each call with a functionResponse part.
        contents.push(content.clone());
        let mut resp_parts: Vec<Value> = Vec::new();
        for part in parts.iter().filter(|p| p.get("functionCall").is_some()) {
            let fc = &part["functionCall"];
            let ns_name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = fc
                .get("args")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            let response = match dispatch.get(ns_name) {
                Some((idx, orig)) => {
                    tools_used.push(ToolUsed {
                        name: orig.clone(),
                        connection_label: labels.get(*idx).cloned().unwrap_or_default(),
                    });
                    match clients[*idx].call_tool(orig, args).await {
                        Ok(result) => tool_result_to_response(&result),
                        Err(e) => serde_json::json!({ "isError": true, "error": e.to_string() }),
                    }
                }
                None => serde_json::json!({ "isError": true, "error": "unknown tool" }),
            };
            resp_parts.push(serde_json::json!({
                "functionResponse": { "name": ns_name, "response": response }
            }));
        }
        contents.push(serde_json::json!({ "role": "user", "parts": resp_parts }));
    }

    // Hit the round cap — force a final answer with tools disabled.
    let content = gemini_generate(&contents, &[], api_key, model).await?;
    Ok(ChatResult {
        reply: stitch_text(&content_parts(&content)),
        tools_used,
    })
}

/// Plain single-shot Gemini call (no tools). Identical in spirit to the old
/// passthrough handler.
async fn passthrough(
    contents: &[Value],
    api_key: &str,
    model: &str,
) -> Result<ChatResult, AppError> {
    let content = gemini_generate(contents, &[], api_key, model).await?;
    Ok(ChatResult {
        reply: stitch_text(&content_parts(&content)),
        tools_used: Vec::new(),
    })
}

/// Discover the caller's MCP tools, or `None` if they aren't an MCP owner, have
/// no enabled connections, or none of them yield usable tools.
async fn load_mcp_tools(pool: &PgPool, user_id: i32) -> Option<LoadedMcp> {
    let owner = resolve_mcp_owner_opt(pool, user_id).await?;
    let connections = load_connections(pool, owner, true).await.ok()?;
    if connections.is_empty() {
        return None;
    }

    let mut clients: Vec<McpClient> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    let mut decls: Vec<Value> = Vec::new();
    let mut dispatch: HashMap<String, (usize, String)> = HashMap::new();

    for conn in &connections {
        let client = McpClient::new(&conn.server_url, conn.auth_token.as_deref());
        // A server that fails the handshake or tool listing is skipped, not fatal
        // — the chat still works with the remaining servers (or as a passthrough).
        if let Err(e) = client.initialize().await {
            warn!(target: "ai", label = %conn.label, error = %e, "mcp server initialize failed; skipping");
            continue;
        }
        let tools = match client.list_tools().await {
            Ok(t) => t,
            Err(e) => {
                warn!(target: "ai", label = %conn.label, error = %e, "mcp tools/list failed; skipping");
                continue;
            }
        };
        let idx = clients.len();
        clients.push(client);
        labels.push(conn.label.clone());
        for tool in tools {
            if decls.len() >= MAX_TOOLS {
                warn!(target: "ai", "mcp tool cap ({MAX_TOOLS}) reached; remaining tools dropped");
                break;
            }
            let ns_name = namespaced_name(idx, &tool.name);
            let mut decl = serde_json::json!({ "name": ns_name });
            if let Some(desc) = &tool.description {
                decl["description"] = Value::String(desc.clone());
            }
            if let Some(params) = tool_parameters(tool.input_schema.as_ref()) {
                decl["parameters"] = params;
            }
            decls.push(decl);
            dispatch.insert(ns_name, (idx, tool.name.clone()));
        }
    }

    if decls.is_empty() {
        return None;
    }
    Some(LoadedMcp {
        clients,
        labels,
        decls,
        dispatch,
    })
}

/// POST to Gemini's `generateContent`, optionally with `tools`. Returns the
/// model turn (`candidates[0].content`), or `Null` if absent.
async fn gemini_generate(
    contents: &[Value],
    decls: &[Value],
    api_key: &str,
    model: &str,
) -> Result<Value, AppError> {
    let url = format!(
        "{}/v1beta/models/{}:generateContent?key={}",
        crate::external::gemini_base(),
        model,
        api_key
    );
    let mut body = serde_json::json!({ "contents": contents });
    if !decls.is_empty() {
        body["tools"] = serde_json::json!([{ "functionDeclarations": decls }]);
    }

    let res = HTTP_CLIENT
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            warn!(target: "ai", error = ?e, "gemini transport error");
            AppError::Internal("AI upstream error".into())
        })?;
    let status = res.status();
    let payload: Value = res.json().await.map_err(|e| {
        warn!(target: "ai", error = ?e, "gemini response parse failed");
        AppError::Internal("AI bad upstream response".into())
    })?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("Upstream error")
            .to_string();
        warn!(target: "ai", %status, msg, "gemini non-2xx");
        return Err(AppError::Internal(format!("AI upstream error: {msg}")));
    }
    Ok(payload["candidates"][0]["content"].clone())
}

fn content_parts(content: &Value) -> Vec<Value> {
    content
        .get("parts")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default()
}

fn stitch_text(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

/// Convert an MCP `tools/call` result into the JSON object Gemini's
/// `functionResponse.response` requires. Prefers `structuredContent`; otherwise
/// joins text blocks (truncated). Carries `isError` through.
fn tool_result_to_response(result: &Value) -> Value {
    let is_error = result
        .get("isError")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);

    if let Some(sc) = result.get("structuredContent").filter(|v| v.is_object()) {
        return serde_json::json!({ "isError": is_error, "structuredContent": sc });
    }

    let mut text = String::new();
    if let Some(arr) = result.get("content").and_then(|c| c.as_array()) {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text")
                && let Some(t) = block.get("text").and_then(|t| t.as_str())
            {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
        }
    }
    serde_json::json!({ "isError": is_error, "result": truncate(&text, MAX_TOOL_OUTPUT) })
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("… [truncated]");
    out
}

/// Namespace a tool name with its connection index so two servers can expose the
/// same tool name and the dispatcher knows the owner. Also coerces the name into
/// Gemini's allowed identifier set and length.
fn namespaced_name(idx: usize, name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut out = format!("c{idx}_{cleaned}");
    if out.len() > 63 {
        out.truncate(63);
    }
    out
}

/// Build a Gemini `parameters` schema from an MCP tool's `inputSchema`, or
/// `None` when the tool takes no arguments.
fn tool_parameters(input_schema: Option<&Value>) -> Option<Value> {
    let schema = input_schema?;
    if !schema.is_object() {
        return None;
    }
    let sanitized = sanitize_schema(schema);
    let has_props = sanitized
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    if has_props { Some(sanitized) } else { None }
}

/// Recursively reduce full JSON Schema to the subset Gemini's function-calling
/// accepts. Unknown keywords (`$schema`, `$ref`, `additionalProperties`,
/// `format`, `title`, `$defs`, `patternProperties`, …) are dropped, and a
/// `type: ["string","null"]` union collapses to a single type, since Gemini 400s
/// on any of those.
fn sanitize_schema(schema: &Value) -> Value {
    let Some(map) = schema.as_object() else {
        return serde_json::json!({ "type": "string" });
    };
    let mut out = serde_json::Map::new();
    for (key, val) in map {
        match key.as_str() {
            "type" => {
                if let Some(arr) = val.as_array() {
                    // Prefer the first non-"null" type; fall back to the first.
                    let chosen = arr
                        .iter()
                        .filter_map(|t| t.as_str())
                        .find(|t| *t != "null")
                        .or_else(|| arr.iter().find_map(|t| t.as_str()));
                    if let Some(t) = chosen {
                        out.insert("type".into(), Value::String(t.to_string()));
                    }
                } else if let Some(s) = val.as_str() {
                    out.insert("type".into(), Value::String(s.to_string()));
                }
            }
            "description" | "enum" | "required" | "minimum" | "maximum" | "nullable" => {
                out.insert(key.clone(), val.clone());
            }
            "properties" => {
                if let Some(props) = val.as_object() {
                    let mut sanitized_props = serde_json::Map::new();
                    for (pk, pv) in props {
                        sanitized_props.insert(pk.clone(), sanitize_schema(pv));
                    }
                    out.insert("properties".into(), Value::Object(sanitized_props));
                }
            }
            "items" => {
                out.insert("items".into(), sanitize_schema(val));
            }
            // Everything else is dropped.
            _ => {}
        }
    }
    // Gemini prefers object schemas to carry a (possibly empty) properties map.
    if out.get("type").and_then(|t| t.as_str()) == Some("object") && !out.contains_key("properties")
    {
        out.insert("properties".into(), Value::Object(serde_json::Map::new()));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizer_strips_unsupported_and_collapses_type_unions() {
        let schema = serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "additionalProperties": false,
            "title": "Args",
            "properties": {
                "city": { "type": ["string", "null"], "description": "City", "format": "hostname" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
            },
            "required": ["city"]
        });
        let out = sanitize_schema(&schema);
        assert_eq!(out["type"], serde_json::json!("object"));
        assert!(out.get("$schema").is_none());
        assert!(out.get("additionalProperties").is_none());
        assert!(out.get("title").is_none());
        assert_eq!(
            out["properties"]["city"]["type"],
            serde_json::json!("string")
        );
        assert!(out["properties"]["city"].get("format").is_none());
        assert_eq!(out["properties"]["limit"]["minimum"], serde_json::json!(1));
        assert_eq!(out["required"], serde_json::json!(["city"]));
    }

    #[test]
    fn no_args_schema_yields_no_parameters() {
        let schema = serde_json::json!({ "type": "object", "properties": {} });
        assert!(tool_parameters(Some(&schema)).is_none());
    }

    #[test]
    fn namespacing_is_safe_and_bounded() {
        let n = namespaced_name(2, "read/orders table");
        assert!(n.starts_with("c2_"));
        assert!(
            n.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
        );
        let long = namespaced_name(1, &"x".repeat(200));
        assert!(long.len() <= 63);
    }

    #[test]
    fn tool_result_joins_text_and_truncates() {
        let result = serde_json::json!({
            "content": [
                { "type": "text", "text": "row1" },
                { "type": "text", "text": "row2" }
            ],
            "isError": false
        });
        let resp = tool_result_to_response(&result);
        assert_eq!(resp["result"], serde_json::json!("row1\nrow2"));
        assert_eq!(resp["isError"], serde_json::json!(false));
    }
}
