//! The agentic chat loop, provider-agnostic. The org's AI provider is resolved
//! per request (see `ai::provider::resolve_ai_for_user`) and the loop dispatches
//! to Gemini, Anthropic, or any OpenAI-compatible endpoint. When the caller is an
//! MCP owner (enterprise org or platform) with connected servers, their tools are
//! declared to the model and a bounded tool-call loop lets it read the customer's
//! systems through `tools/call`. Everyone else gets the plain passthrough.
//!
//! MCP discovery is done once, provider-neutral; each provider then formats those
//! tools into its own declaration shape and runs its own message loop. Non-
//! streaming to match the frontend, which awaits a single `{reply}` (extended with
//! an optional `tools_used` list).

use crate::ai::native_tools;
use crate::ai::provider::{AiProvider, DataAccess, ResolvedAi};
use crate::integrations::mcp::client::{McpClient, validate_server_url};
use crate::integrations::mcp::handler::{load_connections, resolve_mcp_owner_opt};
use crate::prelude::*;
use std::collections::HashMap;
use std::time::Duration;
use tracing::warn;

/// Max tool-calling rounds before we force a final, tool-less answer. Bounds a
/// misbehaving server from trapping the model in an endless call cycle.
const MAX_ROUNDS: usize = 5;
/// Cap on how many tools we declare to the model in one request.
const MAX_TOOLS: usize = 64;
/// Cap on a single tool's textual output fed back to the model (chars).
const MAX_TOOL_OUTPUT: usize = 8000;
/// Output token cap for providers that require one (Anthropic).
const MAX_OUTPUT_TOKENS: u32 = 2048;

/// Dedicated outbound client for AI providers: redirects OFF so a custom
/// `base_url` can't 302 us onto an internal address, with LLM-friendly timeouts.
static AI_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap()
});

/// A normalized conversation turn from the client: `role` is "user" or "model";
/// `content` is non-empty (the handler filters blanks).
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// One tool invocation surfaced to the UI (no arguments/output — just what ran).
#[derive(Serialize)]
pub struct ToolUsed {
    pub name: String,
    pub connection_label: String,
}

/// An action the assistant PROPOSED but did not perform. Outward-facing or
/// irreversible actions (e.g. sending an email) never execute inside the agent
/// loop — the browser performs them through the existing authenticated endpoint
/// after the user clicks Confirm. Serialized into the chat response's
/// `pending_actions` array so the UI can render a confirmation card.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PendingAction {
    Email {
        to: String,
        subject: String,
        body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        account_id: Option<i32>,
    },
}

pub struct ChatResult {
    pub reply: String,
    pub tools_used: Vec<ToolUsed>,
    pub pending_actions: Vec<PendingAction>,
    /// Prompt/completion tokens summed across every provider call in this turn
    /// (tool-call rounds included). 0 when the provider didn't report usage.
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Pull a nested integer (`root[a][b]`) from a provider response, defaulting to
/// 0. Used to read token counts, which live at a different path per provider.
fn nested_i64(root: &Value, a: &str, b: &str) -> i64 {
    root.get(a)
        .and_then(|x| x.get(b))
        .and_then(|x| x.as_i64())
        .unwrap_or(0)
}

/// Estimated cost of one turn in **micro-cents** (millionths of a cent), from
/// the model and its token counts. Prices are cents per 1M tokens (input,
/// output); an unknown model bills 0 so a missing entry never fabricates spend.
/// Matched loosely by model-name substring so dated/aliased ids resolve to the
/// right family.
///
/// Micro-cents (not cents) is the stored unit on purpose: a single sub-cent turn
/// truncated to whole cents reads as `$0.00`, and many such turns each truncate
/// to zero, systematically understating spend. Storing the un-divided figure
/// lets the dashboard `SUM(...)` losslessly and divide by 1_000_000 exactly once.
pub fn cost_micro_cents(model: &str, input_tokens: i64, output_tokens: i64) -> i64 {
    let m = model.to_ascii_lowercase();
    let (in_per_m, out_per_m): (i64, i64) = if m.contains("opus") {
        (500, 2500)
    } else if m.contains("haiku") {
        (100, 500)
    } else if m.contains("sonnet") {
        (300, 1500)
    } else if m.contains("gpt-4o-mini") || m.contains("mini") {
        (15, 60)
    } else if m.contains("gpt-4o") || m.contains("gpt-4") {
        (250, 1000)
    } else if m.contains("gemini") && m.contains("pro") {
        (125, 500)
    } else if m.contains("gemini") {
        (8, 30)
    } else {
        (0, 0)
    };
    input_tokens * in_per_m + output_tokens * out_per_m
}

/// One tool declared to the model, provider-neutral — either a Wayve-native
/// action (see `native_tools`) or a discovered MCP tool. Each provider formats
/// this into its own declaration shape (Gemini `functionDeclarations`, Anthropic
/// `tools`, OpenAI `tools`).
#[derive(Clone)]
pub(crate) struct NeutralTool {
    pub(crate) ns_name: String,
    pub(crate) description: Option<String>,
    pub(crate) input_schema: Option<Value>,
}

/// Live MCP state for one chat: the aligned clients/labels, the neutral tool
/// list, and a map from the namespaced tool name back to its owning client +
/// original name.
struct LoadedMcp {
    clients: Vec<McpClient>,
    labels: Vec<String>,
    tools: Vec<NeutralTool>,
    dispatch: HashMap<String, (usize, String)>,
}

/// Everything a tool call needs at dispatch time: the DB pool + caller (for
/// native tools), the always-present native tool set, and the caller's MCP tools
/// (when they are an MCP owner). Built once per chat in `run`.
struct ToolCtx<'a> {
    pool: Option<&'a PgPool>,
    user_id: i32,
    native: Vec<NeutralTool>,
    loaded: Option<LoadedMcp>,
    /// Which data categories native tools may touch (from the resolved config).
    access: DataAccess,
}

impl<'a> ToolCtx<'a> {
    /// Native action tools are available to EVERY caller; MCP tools only when
    /// `load_mcp_tools` found some. Native tools are filtered to the data
    /// categories `access` allows.
    fn for_chat(
        pool: &'a PgPool,
        user_id: i32,
        loaded: Option<LoadedMcp>,
        access: DataAccess,
    ) -> Self {
        Self {
            pool: Some(pool),
            user_id,
            native: native_tools::declarations(access),
            loaded,
            access,
        }
    }

    /// A tool-less context for provider probing (config validation).
    fn none() -> Self {
        Self {
            pool: None,
            user_id: 0,
            native: Vec::new(),
            loaded: None,
            access: DataAccess::default(),
        }
    }

    /// Native tools first, then MCP — the full set declared to the model.
    fn declared_tools(&self) -> Vec<NeutralTool> {
        let mut all = self.native.clone();
        if let Some(loaded) = &self.loaded {
            all.extend(loaded.tools.iter().cloned());
        }
        all
    }
}

/// Run a chat turn against the resolved provider. `msgs` is the normalized
/// conversation. If the provider fails and the org allowed it (`!fail_closed` and
/// the provider isn't already the platform default), retry on the platform Gemini.
pub async fn run(
    pool: &PgPool,
    user_id: i32,
    msgs: Vec<ChatMsg>,
    ai: &ResolvedAi,
) -> Result<ChatResult, AppError> {
    let loaded = load_mcp_tools(pool, user_id).await;
    // Native action/read tools are declared to the model for EVERY caller,
    // alongside any MCP tools the caller owns.
    let ctx = ToolCtx::for_chat(pool, user_id, loaded, ai.data_access);

    match run_one(&msgs, &ctx, ai).await {
        Ok(result) => Ok(result),
        Err(e) if !ai.fail_closed && ai.provider != AiProvider::Gemini => {
            // The owner explicitly allowed falling back to the platform default.
            match crate::config::gemini_api_key() {
                Some(key) => {
                    warn!(target: "ai", error = %e, "AI provider failed; falling back to platform default");
                    let fallback = ResolvedAi {
                        provider: AiProvider::Gemini,
                        api_key: key,
                        model: crate::config::gemini_model(),
                        base_url: None,
                        fail_closed: false,
                        // Preserve the owner's data-access choice on fallback.
                        data_access: ai.data_access,
                    };
                    run_one(&msgs, &ctx, &fallback).await
                }
                None => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

async fn run_one(
    msgs: &[ChatMsg],
    ctx: &ToolCtx<'_>,
    ai: &ResolvedAi,
) -> Result<ChatResult, AppError> {
    match ai.provider {
        AiProvider::Gemini => run_gemini(msgs, ctx, ai).await,
        AiProvider::Anthropic => run_anthropic(msgs, ctx, ai).await,
        AiProvider::OpenAiCompatible => run_openai(msgs, ctx, ai).await,
    }
}

/// Validate a provider config by making one trivial, tool-less request. Used by
/// the config endpoint to reject a bad key/model/endpoint before storing it.
pub async fn probe(ai: &ResolvedAi) -> Result<(), AppError> {
    let msgs = vec![ChatMsg {
        role: "user".to_string(),
        content: "ping".to_string(),
    }];
    run_one(&msgs, &ToolCtx::none(), ai).await.map(|_| ())
}

/// Run a single, **tool-less** completion against the resolved provider and
/// return the model's text. For focused one-shot uses (e.g. mapping a task to
/// likely files) that want a plain answer, not the agentic tool loop.
pub async fn complete(ai: &ResolvedAi, prompt: &str) -> Result<String, AppError> {
    let msgs = vec![ChatMsg {
        role: "user".to_string(),
        content: prompt.to_string(),
    }];
    run_one(&msgs, &ToolCtx::none(), ai).await.map(|r| r.reply)
}

/// Dispatch one tool call. Native Wayve tools are tried first (their reserved
/// name prefix can't collide with the MCP `c{idx}_` namespacing); otherwise the
/// call routes to its owning MCP client. Returns the `ToolUsed` breadcrumb (for
/// the UI), the response value (Gemini-shaped object), and any `PendingAction`
/// the tool proposed (e.g. a `compose_email` draft awaiting user confirmation).
async fn dispatch_tool(
    ctx: &ToolCtx<'_>,
    ns_name: &str,
    args: Value,
) -> (Option<ToolUsed>, Value, Option<PendingAction>) {
    if let Some(pool) = ctx.pool
        && let Some(outcome) =
            native_tools::dispatch(pool, ctx.user_id, ns_name, &args, ctx.access).await
    {
        return outcome;
    }
    let Some(loaded) = &ctx.loaded else {
        return (
            None,
            serde_json::json!({ "isError": true, "error": "unknown tool" }),
            None,
        );
    };
    match loaded.dispatch.get(ns_name) {
        Some((idx, orig)) => {
            let used = ToolUsed {
                name: orig.clone(),
                connection_label: loaded.labels.get(*idx).cloned().unwrap_or_default(),
            };
            let resp = match loaded.clients[*idx].call_tool(orig, args).await {
                Ok(result) => tool_result_to_response(&result),
                Err(e) => serde_json::json!({ "isError": true, "error": e.to_string() }),
            };
            (Some(used), resp, None)
        }
        None => (
            None,
            serde_json::json!({ "isError": true, "error": "unknown tool" }),
            None,
        ),
    }
}

// ───────────────────────────── Gemini ─────────────────────────────

/// SSRF re-check for a custom provider `base_url`, run before every request the
/// way the MCP client does (defeats DNS rebinding between save and use). Vendor
/// default bases (operator-configured via env) are trusted and not re-checked.
async fn guard_base(ai: &ResolvedAi) -> Result<(), AppError> {
    if let Some(base) = ai.base_url.as_deref() {
        validate_server_url(base).await?;
    }
    Ok(())
}

async fn run_gemini(
    msgs: &[ChatMsg],
    ctx: &ToolCtx<'_>,
    ai: &ResolvedAi,
) -> Result<ChatResult, AppError> {
    let mut contents: Vec<Value> = msgs
        .iter()
        .map(|m| {
            let role = if m.role == "model" { "model" } else { "user" };
            serde_json::json!({ "role": role, "parts": [{ "text": m.content }] })
        })
        .collect();
    let decls = gemini_decls(&ctx.declared_tools());
    let mut tools_used: Vec<ToolUsed> = Vec::new();
    let mut pending_actions: Vec<PendingAction> = Vec::new();
    let mut in_tokens = 0i64;
    let mut out_tokens = 0i64;

    for _round in 0..MAX_ROUNDS {
        let payload = gemini_generate(&contents, &decls, ai).await?;
        in_tokens += nested_i64(&payload, "usageMetadata", "promptTokenCount");
        out_tokens += nested_i64(&payload, "usageMetadata", "candidatesTokenCount");
        let content = payload["candidates"][0]["content"].clone();
        let parts = content_parts(&content);
        if !parts.iter().any(|p| p.get("functionCall").is_some()) {
            return Ok(ChatResult {
                reply: stitch_text(&parts),
                tools_used,
                pending_actions,
                input_tokens: in_tokens,
                output_tokens: out_tokens,
            });
        }
        contents.push(content.clone());
        let mut resp_parts: Vec<Value> = Vec::new();
        for part in parts.iter().filter(|p| p.get("functionCall").is_some()) {
            let fc = &part["functionCall"];
            let ns_name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = fc
                .get("args")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let (used, resp, pending) = dispatch_tool(ctx, ns_name, args).await;
            if let Some(u) = used {
                tools_used.push(u);
            }
            if let Some(p) = pending {
                pending_actions.push(p);
            }
            resp_parts.push(serde_json::json!({
                "functionResponse": { "name": ns_name, "response": resp }
            }));
        }
        contents.push(serde_json::json!({ "role": "user", "parts": resp_parts }));
    }

    let payload = gemini_generate(&contents, &[], ai).await?;
    in_tokens += nested_i64(&payload, "usageMetadata", "promptTokenCount");
    out_tokens += nested_i64(&payload, "usageMetadata", "candidatesTokenCount");
    let content = payload["candidates"][0]["content"].clone();
    Ok(ChatResult {
        reply: stitch_text(&content_parts(&content)),
        tools_used,
        pending_actions,
        input_tokens: in_tokens,
        output_tokens: out_tokens,
    })
}

fn gemini_decls(tools: &[NeutralTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let mut decl = serde_json::json!({ "name": t.ns_name });
            if let Some(d) = &t.description {
                decl["description"] = Value::String(d.clone());
            }
            if let Some(p) = tool_parameters(t.input_schema.as_ref()) {
                decl["parameters"] = p;
            }
            decl
        })
        .collect()
}

/// POST to Gemini's `generateContent`, optionally with `tools`. Returns the model
/// turn (`candidates[0].content`), or `Null` if absent.
async fn gemini_generate(
    contents: &[Value],
    decls: &[Value],
    ai: &ResolvedAi,
) -> Result<Value, AppError> {
    guard_base(ai).await?;
    let base = ai
        .base_url
        .clone()
        .unwrap_or_else(crate::external::gemini_base);
    let url = format!(
        "{}/v1beta/models/{}:generateContent?key={}",
        base.trim_end_matches('/'),
        ai.model,
        ai.api_key
    );
    let mut body = serde_json::json!({ "contents": contents });
    if !decls.is_empty() {
        body["tools"] = serde_json::json!([{ "functionDeclarations": decls }]);
    }

    let res = AI_HTTP_CLIENT
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
    // Return the full response so the caller can read both the model turn
    // (`candidates[0].content`) and token usage (`usageMetadata`).
    Ok(payload)
}

// ──────────────────────────── Anthropic ────────────────────────────

async fn run_anthropic(
    msgs: &[ChatMsg],
    ctx: &ToolCtx<'_>,
    ai: &ResolvedAi,
) -> Result<ChatResult, AppError> {
    let mut messages: Vec<Value> = msgs
        .iter()
        .map(|m| {
            let role = if m.role == "model" {
                "assistant"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "content": m.content })
        })
        .collect();
    let tools = anthropic_tools(&ctx.declared_tools());
    let mut tools_used: Vec<ToolUsed> = Vec::new();
    let mut pending_actions: Vec<PendingAction> = Vec::new();
    let mut in_tokens = 0i64;
    let mut out_tokens = 0i64;

    for _round in 0..MAX_ROUNDS {
        let payload = anthropic_generate(&messages, &tools, ai).await?;
        in_tokens += nested_i64(&payload, "usage", "input_tokens");
        out_tokens += nested_i64(&payload, "usage", "output_tokens");
        let blocks = payload
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let has_tool = blocks
            .iter()
            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"));
        if !has_tool {
            return Ok(ChatResult {
                reply: anthropic_text(&blocks),
                tools_used,
                pending_actions,
                input_tokens: in_tokens,
                output_tokens: out_tokens,
            });
        }
        // Echo the assistant turn (carries the tool_use blocks), then answer each.
        messages.push(serde_json::json!({ "role": "assistant", "content": blocks.clone() }));
        let mut results: Vec<Value> = Vec::new();
        for b in blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        {
            let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let input = b
                .get("input")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let (used, resp, pending) = dispatch_tool(ctx, name, input).await;
            if let Some(u) = used {
                tools_used.push(u);
            }
            if let Some(p) = pending {
                pending_actions.push(p);
            }
            results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": response_to_text(&resp),
            }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": results }));
    }

    let payload = anthropic_generate(&messages, &[], ai).await?;
    in_tokens += nested_i64(&payload, "usage", "input_tokens");
    out_tokens += nested_i64(&payload, "usage", "output_tokens");
    let blocks = payload
        .get("content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(ChatResult {
        reply: anthropic_text(&blocks),
        tools_used,
        pending_actions,
        input_tokens: in_tokens,
        output_tokens: out_tokens,
    })
}

fn anthropic_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

fn anthropic_tools(tools: &[NeutralTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let mut decl = serde_json::json!({
                "name": t.ns_name,
                "input_schema": object_schema(t.input_schema.as_ref()),
            });
            if let Some(d) = &t.description {
                decl["description"] = Value::String(d.clone());
            }
            decl
        })
        .collect()
}

/// POST to Anthropic's Messages API. Returns the full response object (caller
/// reads `content` + decides on tool calls).
async fn anthropic_generate(
    messages: &[Value],
    tools: &[Value],
    ai: &ResolvedAi,
) -> Result<Value, AppError> {
    guard_base(ai).await?;
    let base = ai
        .base_url
        .clone()
        .unwrap_or_else(crate::external::anthropic_base);
    let url = format!("{}/v1/messages", base.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": ai.model,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::json!(tools);
    }

    let res = AI_HTTP_CLIENT
        .post(&url)
        .header("x-api-key", &ai.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            warn!(target: "ai", error = ?e, "anthropic transport error");
            AppError::Internal("AI upstream error".into())
        })?;
    let status = res.status();
    let payload: Value = res.json().await.map_err(|e| {
        warn!(target: "ai", error = ?e, "anthropic response parse failed");
        AppError::Internal("AI bad upstream response".into())
    })?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("Upstream error")
            .to_string();
        warn!(target: "ai", %status, msg, "anthropic non-2xx");
        return Err(AppError::Internal(format!("AI upstream error: {msg}")));
    }
    Ok(payload)
}

// ─────────────────────── OpenAI-compatible ────────────────────────

async fn run_openai(
    msgs: &[ChatMsg],
    ctx: &ToolCtx<'_>,
    ai: &ResolvedAi,
) -> Result<ChatResult, AppError> {
    let mut messages: Vec<Value> = msgs
        .iter()
        .map(|m| {
            let role = if m.role == "model" {
                "assistant"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "content": m.content })
        })
        .collect();
    let tools = openai_tools(&ctx.declared_tools());
    let mut tools_used: Vec<ToolUsed> = Vec::new();
    let mut pending_actions: Vec<PendingAction> = Vec::new();
    let mut in_tokens = 0i64;
    let mut out_tokens = 0i64;

    for _round in 0..MAX_ROUNDS {
        let payload = openai_generate(&messages, &tools, ai).await?;
        in_tokens += nested_i64(&payload, "usage", "prompt_tokens");
        out_tokens += nested_i64(&payload, "usage", "completion_tokens");
        let message = payload["choices"][0]["message"].clone();
        let tool_calls = message
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();
        if tool_calls.is_empty() {
            return Ok(ChatResult {
                reply: message
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                tools_used,
                pending_actions,
                input_tokens: in_tokens,
                output_tokens: out_tokens,
            });
        }
        // Echo the assistant turn (carries tool_calls), then answer each.
        messages.push(message.clone());
        for tc in &tool_calls {
            let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let func = tc
                .get("function")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let name = func.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args: Value = func
                .get("arguments")
                .and_then(|a| a.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            let (used, resp, pending) = dispatch_tool(ctx, name, args).await;
            if let Some(u) = used {
                tools_used.push(u);
            }
            if let Some(p) = pending {
                pending_actions.push(p);
            }
            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": response_to_text(&resp),
            }));
        }
    }

    let payload = openai_generate(&messages, &[], ai).await?;
    in_tokens += nested_i64(&payload, "usage", "prompt_tokens");
    out_tokens += nested_i64(&payload, "usage", "completion_tokens");
    let message = payload["choices"][0]["message"].clone();
    Ok(ChatResult {
        reply: message
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        tools_used,
        pending_actions,
        input_tokens: in_tokens,
        output_tokens: out_tokens,
    })
}

fn openai_tools(tools: &[NeutralTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.ns_name,
                    "description": t.description.clone().unwrap_or_default(),
                    "parameters": object_schema(t.input_schema.as_ref()),
                }
            })
        })
        .collect()
}

/// POST to an OpenAI-compatible `/chat/completions`. Returns `choices[0].message`.
async fn openai_generate(
    messages: &[Value],
    tools: &[Value],
    ai: &ResolvedAi,
) -> Result<Value, AppError> {
    guard_base(ai).await?;
    let base = ai.base_url.clone().ok_or_else(|| {
        AppError::Internal("OpenAI-compatible provider requires a base URL".into())
    })?;
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let mut body = serde_json::json!({ "model": ai.model, "messages": messages });
    if !tools.is_empty() {
        body["tools"] = serde_json::json!(tools);
    }

    let res = AI_HTTP_CLIENT
        .post(&url)
        .bearer_auth(&ai.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            warn!(target: "ai", error = ?e, "openai transport error");
            AppError::Internal("AI upstream error".into())
        })?;
    let status = res.status();
    let payload: Value = res.json().await.map_err(|e| {
        warn!(target: "ai", error = ?e, "openai response parse failed");
        AppError::Internal("AI bad upstream response".into())
    })?;
    if !status.is_success() {
        let msg = payload["error"]["message"]
            .as_str()
            .unwrap_or("Upstream error")
            .to_string();
        warn!(target: "ai", %status, msg, "openai non-2xx");
        return Err(AppError::Internal(format!("AI upstream error: {msg}")));
    }
    // Return the full response so the caller can read both the assistant message
    // (`choices[0].message`) and token usage (`usage`).
    Ok(payload)
}

// ───────────────────────── MCP discovery ──────────────────────────

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
    let mut tools: Vec<NeutralTool> = Vec::new();
    let mut dispatch: HashMap<String, (usize, String)> = HashMap::new();

    for conn in &connections {
        let client = McpClient::new(&conn.server_url, conn.auth_token.as_deref());
        // A server that fails the handshake or tool listing is skipped, not fatal
        // — the chat still works with the remaining servers (or as a passthrough).
        if let Err(e) = client.initialize().await {
            warn!(target: "ai", label = %conn.label, error = %e, "mcp server initialize failed; skipping");
            continue;
        }
        let server_tools = match client.list_tools().await {
            Ok(t) => t,
            Err(e) => {
                warn!(target: "ai", label = %conn.label, error = %e, "mcp tools/list failed; skipping");
                continue;
            }
        };
        let idx = clients.len();
        clients.push(client);
        labels.push(conn.label.clone());
        for tool in server_tools {
            if tools.len() >= MAX_TOOLS {
                warn!(target: "ai", "mcp tool cap ({MAX_TOOLS}) reached; remaining tools dropped");
                break;
            }
            let ns_name = namespaced_name(idx, &tool.name);
            tools.push(NeutralTool {
                ns_name: ns_name.clone(),
                description: tool.description.clone(),
                input_schema: tool.input_schema.clone(),
            });
            dispatch.insert(ns_name, (idx, tool.name.clone()));
        }
    }

    if tools.is_empty() {
        return None;
    }
    Some(LoadedMcp {
        clients,
        labels,
        tools,
        dispatch,
    })
}

// ───────────────────────────── helpers ─────────────────────────────

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
/// joins text blocks (truncated). Carries `isError` through. Anthropic/OpenAI
/// reuse this and stringify it via [`response_to_text`].
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

/// Stringify a tool response for providers that pass tool results as text
/// (Anthropic `tool_result.content`, OpenAI `tool` message content).
fn response_to_text(resp: &Value) -> String {
    truncate(&resp.to_string(), MAX_TOOL_OUTPUT)
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
/// the providers' allowed identifier set and length.
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

/// Build a Gemini `parameters` schema from an MCP tool's `inputSchema`, or `None`
/// when the tool takes no arguments.
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

/// An object JSON Schema for Anthropic `input_schema` / OpenAI `parameters`,
/// which both require an object schema even when the tool takes no arguments.
fn object_schema(input_schema: Option<&Value>) -> Value {
    match input_schema {
        Some(s) if s.is_object() => {
            let sanitized = sanitize_schema(s);
            if sanitized.get("type").and_then(|t| t.as_str()) == Some("object") {
                sanitized
            } else {
                serde_json::json!({ "type": "object", "properties": {} })
            }
        }
        _ => serde_json::json!({ "type": "object", "properties": {} }),
    }
}

/// Recursively reduce full JSON Schema to the subset the providers' function-
/// calling accepts. Unknown keywords (`$schema`, `$ref`, `additionalProperties`,
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
    // Object schemas should carry a (possibly empty) properties map.
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
    fn object_schema_defaults_to_empty_object() {
        assert_eq!(
            object_schema(None),
            serde_json::json!({ "type": "object", "properties": {} })
        );
        // A non-object schema is coerced to the empty object schema.
        let scalar = serde_json::json!({ "type": "string" });
        assert_eq!(
            object_schema(Some(&scalar)),
            serde_json::json!({ "type": "object", "properties": {} })
        );
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
