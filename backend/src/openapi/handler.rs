use crate::prelude::*;
use once_cell::sync::Lazy;
use serde_json::json;
use tracing::instrument;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(openapi_json);
}

// Cached at process startup — the spec is a fixed serde_json::Value built
// once, served as bytes on every request. ETag is the SHA-256 of the body
// so clients can If-None-Match without re-downloading.
static SPEC: Lazy<(Vec<u8>, String)> = Lazy::new(|| {
    let value = build_spec();
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    let hash = format!("\"{:x}\"", md5_like_hash(&bytes));
    (bytes, hash)
});

fn md5_like_hash(bytes: &[u8]) -> u128 {
    // FNV-1a 128 — adequate for an ETag (collision-resistance not required).
    let mut hash: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for &b in bytes {
        hash ^= b as u128;
        hash = hash.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    hash
}

#[get("/openapi.json")]
#[instrument(target = "http")]
pub async fn openapi_json(req: HttpRequest) -> HttpResponse {
    let (bytes, etag) = &*SPEC;
    if let Some(if_none_match) = req.headers().get("If-None-Match")
        && if_none_match.to_str().ok() == Some(etag.as_str())
    {
        return HttpResponse::NotModified().finish();
    }
    HttpResponse::Ok()
        .content_type("application/json")
        .insert_header(("ETag", etag.as_str()))
        .insert_header(("Cache-Control", "public, max-age=300"))
        .body(bytes.clone())
}

// ──────────────────────────────────────────────────────────────────────
// Spec
// ──────────────────────────────────────────────────────────────────────

fn build_spec() -> serde_json::Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Wayve API",
            "version": "2026.05",
            "summary": "Programmatic access to email, chat, scheduling, drive, notes, tasks, and AI.",
            "description": include_str!("description.md"),
            "contact": {
                "name": "Wayve developer support",
                "email": "support@rwayve.maheshg.me",
                "url": "https://rwayve.maheshg.me/support"
            },
            "license": {
                "name": "Commercial",
                "identifier": "LicenseRef-wayve-commercial"
            }
        },
        "servers": [
            { "url": "https://rwayve.maheshg.me", "description": "Production" },
            { "url": "http://localhost:8080",     "description": "Local development" }
        ],
        "security": [{ "ApiKeyAuth": [] }],
        "tags": [
            { "name": "Profile",   "description": "Identity, plan, and entitlements for the calling principal." },
            { "name": "Emails",    "description": "Read messages, send mail, list accounts." },
            { "name": "Chat",      "description": "Direct & channel messaging." },
            { "name": "Scheduler", "description": "Meetings & calendar." },
            { "name": "Drive",     "description": "Files & folders, with sharing." },
            { "name": "Notes",     "description": "Personal notes." },
            { "name": "Tasks",     "description": "To-do items with priority & status." },
            { "name": "AI",        "description": "Assistant chat." },
            { "name": "Webhooks",  "description": "Subscribe to events delivered to your own HTTP endpoint." }
        ],
        "paths": paths(),
        "components": {
            "securitySchemes": {
                "ApiKeyAuth": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "X-API-KEY",
                    "description": "Issued from the Wayve dashboard. Every key carries a scope set, expiry, and rate limit. See the 'Scopes' section in the README."
                }
            },
            "schemas": schemas(),
            "responses": shared_responses()
        },
        "x-scopes": scope_catalog(),
    })
}

fn paths() -> serde_json::Value {
    json!({
        "/api/me": {
            "get": op("Profile", "getMe", "Identity of the calling principal",
                "profile:read",
                json!({ "$ref": "#/components/schemas/MeResponse" })),
        },
        "/api/v1/me": {
            "get": op("Profile", "getApiKeyOrganization", "Organization the API key belongs to",
                "profile:read",
                json!({ "$ref": "#/components/schemas/OrganizationRef" })),
        },

        "/api/accounts": {
            "get": op("Emails", "listAccounts", "Connected mailboxes for this principal",
                "email:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/EmailAccount" } })),
        },
        "/api/emails": {
            "get": op_with_query("Emails", "listEmails",
                "Inbox / sent / important / spam etc., paginated",
                "email:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/Email" } }),
                vec![
                    ("account_id", "integer", "Required. The mailbox to read.", true),
                    ("folder", "string", "inbox | sent | important | updates | spam | drafts | social", false),
                    ("limit", "integer", "Page size (default 75, max 200).", false),
                    ("cursor", "string", "Pagination cursor from a previous response.", false),
                ]),
            "post": op_with_body("Emails", "sendEmail",
                "Send a new message from the connected account",
                "email:send",
                json!({ "$ref": "#/components/schemas/SendEmailInput" }),
                json!({ "$ref": "#/components/schemas/Email" })),
        },
        "/api/emails/{id}": {
            "parameters": [path_param("id", "integer", "Email id")],
            "get": op("Emails", "getEmail", "Single email body + headers",
                "email:read",
                json!({ "$ref": "#/components/schemas/Email" })),
        },
        "/api/emails/{id}/read": {
            "parameters": [path_param("id", "integer", "Email id")],
            "post": op("Emails", "markEmailRead", "Mark an email as read",
                "email:send",
                json!({ "$ref": "#/components/schemas/Ack" })),
        },

        "/api/channels": {
            "get": op("Chat", "listChannels", "Channels the principal belongs to",
                "chat:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/Channel" } })),
            "post": op_with_body("Chat", "createChannel",
                "Create a channel",
                "chat:write",
                json!({ "$ref": "#/components/schemas/CreateChannelInput" }),
                json!({ "$ref": "#/components/schemas/Channel" })),
        },
        "/api/messages": {
            "get": op_with_query("Chat", "listDirectMessages",
                "Direct messages between the principal and another user",
                "chat:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/ChatMessage" } }),
                vec![
                    ("with_user_id", "integer", "Other party's user id.", true),
                    ("limit", "integer", "Page size.", false),
                ]),
            "post": op_with_body("Chat", "sendDirectMessage",
                "Send a direct message (envelope-encrypted)",
                "chat:write",
                json!({ "$ref": "#/components/schemas/SendChatMessageInput" }),
                json!({ "$ref": "#/components/schemas/ChatMessage" })),
        },

        "/api/scheduler/meetings": {
            "get": op("Scheduler", "listMeetings", "Upcoming meetings the principal owns or participates in",
                "scheduler:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/Meeting" } })),
            "post": op_with_body("Scheduler", "createMeeting",
                "Create a meeting (optionally with Zoom / Google Calendar)",
                "scheduler:write",
                json!({ "$ref": "#/components/schemas/CreateMeetingInput" }),
                json!({ "$ref": "#/components/schemas/Meeting" })),
        },

        "/api/drive/files": {
            "get": op("Drive", "listFiles", "Files in the principal's drive",
                "drive:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/DriveFile" } })),
        },
        "/api/files/{id}/download": {
            "parameters": [path_param("id", "integer", "File id")],
            "get": {
                "tags": ["Drive"],
                "operationId": "downloadFile",
                "summary": "Stream a file you own or that has been shared with you",
                "security": [{ "ApiKeyAuth": [] }],
                "x-scope": "drive:read",
                "responses": {
                    "200": {
                        "description": "Binary stream",
                        "content": { "application/octet-stream": { "schema": { "type": "string", "format": "binary" } } }
                    },
                    "401": { "$ref": "#/components/responses/Unauthorized" },
                    "403": { "$ref": "#/components/responses/Forbidden" },
                    "404": { "$ref": "#/components/responses/NotFound" },
                    "429": { "$ref": "#/components/responses/RateLimited" }
                }
            }
        },

        "/api/notes": {
            "get": op("Notes", "listNotes", "All notes for the principal",
                "notes:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/Note" } })),
            "post": op_with_body("Notes", "createNote",
                "Create a note",
                "notes:write",
                json!({ "$ref": "#/components/schemas/CreateNoteInput" }),
                json!({ "$ref": "#/components/schemas/Note" })),
        },
        "/api/notes/{id}": {
            "parameters": [path_param("id", "integer", "Note id")],
            "put": op_with_body("Notes", "updateNote",
                "Replace a note",
                "notes:write",
                json!({ "$ref": "#/components/schemas/CreateNoteInput" }),
                json!({ "$ref": "#/components/schemas/Note" })),
            "delete": op("Notes", "deleteNote", "Delete a note",
                "notes:write",
                json!({ "$ref": "#/components/schemas/Ack" })),
        },

        "/api/tasks": {
            "get": op("Tasks", "listTasks", "All tasks owned by the principal",
                "tasks:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/Task" } })),
            "post": op_with_body("Tasks", "createTask",
                "Create a task",
                "tasks:write",
                json!({ "$ref": "#/components/schemas/TaskInput" }),
                json!({ "$ref": "#/components/schemas/Task" })),
        },
        "/api/tasks/{id}": {
            "parameters": [path_param("id", "integer", "Task id")],
            "put": op_with_body("Tasks", "updateTask",
                "Update a task",
                "tasks:write",
                json!({ "$ref": "#/components/schemas/TaskInput" }),
                json!({ "$ref": "#/components/schemas/Task" })),
            "delete": op("Tasks", "deleteTask", "Delete a task",
                "tasks:write",
                json!({ "$ref": "#/components/schemas/Ack" })),
        },

        "/api/aichat": {
            "post": op_with_body("AI", "aiChat",
                "Send a prompt to the assistant",
                "ai:use",
                json!({ "$ref": "#/components/schemas/AiChatInput" }),
                json!({ "$ref": "#/components/schemas/AiChatOutput" })),
        },

        "/api/webhooks": {
            "get": op("Webhooks", "listWebhooks",
                "Your subscribed webhook endpoints",
                "profile:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/WebhookEndpoint" } })),
            "post": op_with_body("Webhooks", "createWebhook",
                "Register a new endpoint (returns the signing secret exactly once)",
                "profile:read",
                json!({ "$ref": "#/components/schemas/CreateWebhookInput" }),
                json!({ "$ref": "#/components/schemas/CreatedWebhookEndpoint" })),
        },
        "/api/webhooks/{id}": {
            "parameters": [path_param("id", "integer", "Webhook endpoint id")],
            "put": op_with_body("Webhooks", "updateWebhook",
                "Update url / events / enabled",
                "profile:read",
                json!({ "$ref": "#/components/schemas/UpdateWebhookInput" }),
                json!({ "$ref": "#/components/schemas/WebhookEndpoint" })),
            "delete": op("Webhooks", "deleteWebhook", "Delete the endpoint and stop deliveries",
                "profile:read",
                json!({ "$ref": "#/components/schemas/Ack" })),
        },
        "/api/webhooks/{id}/test": {
            "parameters": [path_param("id", "integer", "Webhook endpoint id")],
            "post": op("Webhooks", "testWebhook",
                "Enqueue a synthetic wayve.ping delivery for the endpoint",
                "profile:read",
                json!({ "$ref": "#/components/schemas/Ack" })),
        },
        "/api/webhooks/{id}/deliveries": {
            "parameters": [path_param("id", "integer", "Webhook endpoint id")],
            "get": op("Webhooks", "listDeliveries",
                "Recent delivery attempts (audit + debugging)",
                "profile:read",
                json!({ "type": "array", "items": { "$ref": "#/components/schemas/WebhookDelivery" } })),
        },
        "/api/webhooks/events": {
            "get": op("Webhooks", "listEventCatalog",
                "The frozen catalog of event types we promise to keep stable",
                "profile:read",
                json!({ "type": "object",
                        "properties": {
                            "events": { "type": "array", "items": { "type": "string" } },
                            "api_version": { "type": "string" }
                        }})),
        }
    })
}

fn op(
    tag: &str,
    op_id: &str,
    summary: &str,
    scope: &str,
    response_schema: serde_json::Value,
) -> serde_json::Value {
    json!({
        "tags": [tag],
        "operationId": op_id,
        "summary": summary,
        "security": [{ "ApiKeyAuth": [] }],
        "x-scope": scope,
        "responses": standard_responses(response_schema),
    })
}

#[allow(clippy::too_many_arguments)]
fn op_with_query(
    tag: &str,
    op_id: &str,
    summary: &str,
    scope: &str,
    response_schema: serde_json::Value,
    params: Vec<(&str, &str, &str, bool)>,
) -> serde_json::Value {
    let parameters: Vec<_> = params
        .into_iter()
        .map(|(name, ty, desc, required)| {
            json!({
                "name": name,
                "in": "query",
                "required": required,
                "description": desc,
                "schema": { "type": ty }
            })
        })
        .collect();
    json!({
        "tags": [tag],
        "operationId": op_id,
        "summary": summary,
        "security": [{ "ApiKeyAuth": [] }],
        "x-scope": scope,
        "parameters": parameters,
        "responses": standard_responses(response_schema),
    })
}

#[allow(clippy::too_many_arguments)]
fn op_with_body(
    tag: &str,
    op_id: &str,
    summary: &str,
    scope: &str,
    body_schema: serde_json::Value,
    response_schema: serde_json::Value,
) -> serde_json::Value {
    json!({
        "tags": [tag],
        "operationId": op_id,
        "summary": summary,
        "security": [{ "ApiKeyAuth": [] }],
        "x-scope": scope,
        "requestBody": {
            "required": true,
            "content": { "application/json": { "schema": body_schema } }
        },
        "responses": standard_responses(response_schema),
    })
}

fn standard_responses(success_schema: serde_json::Value) -> serde_json::Value {
    json!({
        "200": {
            "description": "Success",
            "content": { "application/json": { "schema": success_schema } }
        },
        "401": { "$ref": "#/components/responses/Unauthorized" },
        "403": { "$ref": "#/components/responses/Forbidden" },
        "404": { "$ref": "#/components/responses/NotFound" },
        "429": { "$ref": "#/components/responses/RateLimited" }
    })
}

fn path_param(name: &str, ty: &str, desc: &str) -> serde_json::Value {
    json!({
        "name": name,
        "in": "path",
        "required": true,
        "description": desc,
        "schema": { "type": ty }
    })
}

fn shared_responses() -> serde_json::Value {
    json!({
        "Unauthorized": {
            "description": "Missing, invalid, revoked, or expired API key",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorBody" } } }
        },
        "Forbidden": {
            "description": "The key is valid but lacks the scope required for this endpoint",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorBody" } } }
        },
        "NotFound": {
            "description": "Resource does not exist or is not visible to the principal",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorBody" } } }
        },
        "RateLimited": {
            "description": "Per-key requests/minute limit exceeded",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorBody" } } }
        }
    })
}

fn schemas() -> serde_json::Value {
    json!({
        "ErrorBody": {
            "type": "object",
            "properties": { "message": { "type": "string" } },
            "required": ["message"]
        },
        "Ack": {
            "type": "object",
            "properties": { "ok": { "type": "boolean" } }
        },
        "MeResponse": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "email": { "type": "string", "format": "email" },
                "username": { "type": "string", "nullable": true },
                "account_type": { "type": "string", "enum": ["personal", "organization", "organization_admin", "platform_admin"] },
                "scope": { "type": "string", "enum": ["personal", "organization", "platform"] },
                "effective_role": { "type": "string" },
                "permissions": { "type": "array", "items": { "type": "string" } }
            }
        },
        "OrganizationRef": {
            "type": "object",
            "properties": {
                "organization_id": { "type": "integer" },
                "name": { "type": "string", "nullable": true }
            }
        },
        "EmailAccount": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "email": { "type": "string", "format": "email" },
                "display_name": { "type": "string", "nullable": true },
                "unread_count": { "type": "integer" },
                "is_shared": { "type": "boolean" }
            }
        },
        "Email": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "account_id": { "type": "integer" },
                "sender": { "type": "string", "nullable": true },
                "subject": { "type": "string", "nullable": true },
                "snippet": { "type": "string", "nullable": true },
                "body": { "type": "string", "nullable": true,
                          "description": "Plaintext, decrypted at read time" },
                "is_read": { "type": "boolean" },
                "labels": { "type": "array", "items": { "type": "string" } },
                "received_at": { "type": "string", "format": "date-time" }
            }
        },
        "SendEmailInput": {
            "type": "object",
            "required": ["account_id", "to", "subject", "body"],
            "properties": {
                "account_id": { "type": "integer" },
                "to": { "type": "string" },
                "cc": { "type": "string", "nullable": true },
                "bcc": { "type": "string", "nullable": true },
                "subject": { "type": "string" },
                "body": { "type": "string" }
            }
        },
        "Channel": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "name": { "type": "string" },
                "topic": { "type": "string", "nullable": true },
                "is_private": { "type": "boolean" }
            }
        },
        "CreateChannelInput": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string" },
                "topic": { "type": "string", "nullable": true },
                "is_private": { "type": "boolean" }
            }
        },
        "ChatMessage": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "sender_id": { "type": "integer" },
                "recipient_id": { "type": "integer", "nullable": true },
                "channel_id": { "type": "integer", "nullable": true },
                "content": { "type": "string",
                             "description": "End-to-end encrypted envelope; the recipient unwraps locally." },
                "created_at": { "type": "string", "format": "date-time" }
            }
        },
        "SendChatMessageInput": {
            "type": "object",
            "required": ["recipient_id", "content"],
            "properties": {
                "recipient_id": { "type": "integer" },
                "content": { "type": "string",
                             "description": "Pre-encrypted envelope (WAYVE_CHAT_E2E_V1)." }
            }
        },
        "Meeting": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "title": { "type": "string" },
                "starts_at": { "type": "string", "format": "date-time" },
                "ends_at": { "type": "string", "format": "date-time" },
                "zoom_join_url": { "type": "string", "nullable": true }
            }
        },
        "CreateMeetingInput": {
            "type": "object",
            "required": ["title", "starts_at", "ends_at"],
            "properties": {
                "title": { "type": "string" },
                "starts_at": { "type": "string", "format": "date-time" },
                "ends_at": { "type": "string", "format": "date-time" },
                "participants": { "type": "array", "items": { "type": "string", "format": "email" } },
                "create_zoom": { "type": "boolean" }
            }
        },
        "DriveFile": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "name": { "type": "string" },
                "size_bytes": { "type": "integer" },
                "content_type": { "type": "string", "nullable": true },
                "uploaded_at": { "type": "string", "format": "date-time" }
            }
        },
        "Note": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "title": { "type": "string", "nullable": true },
                "content": { "type": "string", "nullable": true },
                "updated_at": { "type": "string", "format": "date-time" }
            }
        },
        "CreateNoteInput": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "nullable": true },
                "content": { "type": "string", "nullable": true }
            }
        },
        "Task": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "priority": { "type": "integer", "minimum": 1, "maximum": 5 },
                "status": { "type": "string", "enum": ["in_progress", "done"] },
                "created_at": { "type": "string", "format": "date-time" }
            }
        },
        "TaskInput": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string" },
                "description": { "type": "string", "nullable": true },
                "priority": { "type": "integer", "minimum": 1, "maximum": 5 },
                "status": { "type": "string", "enum": ["in_progress", "done"] }
            }
        },
        "AiChatInput": {
            "type": "object",
            "required": ["prompt"],
            "properties": {
                "prompt": { "type": "string" },
                "conversation_id": { "type": "string", "nullable": true }
            }
        },
        "AiChatOutput": {
            "type": "object",
            "properties": {
                "reply": { "type": "string" },
                "conversation_id": { "type": "string" }
            }
        },
        "WebhookEndpoint": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "url": { "type": "string", "format": "uri" },
                "description": { "type": "string", "nullable": true },
                "events": { "type": "array", "items": { "type": "string" } },
                "enabled": { "type": "boolean" },
                "org_wide": { "type": "boolean" },
                "organization_id": { "type": "integer", "nullable": true },
                "secret_preview": { "type": "string" },
                "consecutive_failures": { "type": "integer" },
                "last_success_at": { "type": "string", "format": "date-time", "nullable": true },
                "last_failure_at": { "type": "string", "format": "date-time", "nullable": true },
                "created_at": { "type": "string", "format": "date-time" }
            }
        },
        "CreatedWebhookEndpoint": {
            "allOf": [
                { "$ref": "#/components/schemas/WebhookEndpoint" },
                { "type": "object",
                  "required": ["secret"],
                  "properties": {
                    "secret": { "type": "string",
                                "description": "HMAC signing secret. Shown ONLY at creation; store it now." }
                  }}
            ]
        },
        "CreateWebhookInput": {
            "type": "object",
            "required": ["url", "events"],
            "properties": {
                "url": { "type": "string", "format": "uri" },
                "events": { "type": "array", "items": { "type": "string" },
                            "description": "Event types to subscribe to, or \"*\" for all." },
                "description": { "type": "string", "nullable": true },
                "org_wide": { "type": "boolean",
                              "description": "Fire on events from every member of the caller's organization (requires an org-scoped account)." }
            }
        },
        "UpdateWebhookInput": {
            "type": "object",
            "properties": {
                "url": { "type": "string", "format": "uri" },
                "events": { "type": "array", "items": { "type": "string" } },
                "description": { "type": "string", "nullable": true },
                "enabled": { "type": "boolean" }
            }
        },
        "WebhookDelivery": {
            "type": "object",
            "properties": {
                "id": { "type": "integer" },
                "event_id": { "type": "string" },
                "event_type": { "type": "string" },
                "attempt_count": { "type": "integer" },
                "status": { "type": "string",
                            "enum": ["pending", "delivered", "failed", "abandoned"] },
                "http_status": { "type": "integer", "nullable": true },
                "response_excerpt": { "type": "string", "nullable": true },
                "next_attempt_at": { "type": "string", "format": "date-time", "nullable": true },
                "delivered_at": { "type": "string", "format": "date-time", "nullable": true },
                "created_at": { "type": "string", "format": "date-time" }
            }
        }
    })
}

fn scope_catalog() -> serde_json::Value {
    json!([
        { "scope": "profile:read",   "description": "Read identity, plan, and entitlements." },
        { "scope": "email:read",     "description": "List accounts and read messages." },
        { "scope": "email:send",     "description": "Send mail and mutate message state." },
        { "scope": "chat:read",      "description": "Read channels and direct messages." },
        { "scope": "chat:write",     "description": "Send messages, create channels." },
        { "scope": "call:access",    "description": "Initiate or accept WebRTC calls." },
        { "scope": "scheduler:read", "description": "Read meetings & calendar." },
        { "scope": "scheduler:write","description": "Create / update / cancel meetings." },
        { "scope": "drive:read",     "description": "List & download files." },
        { "scope": "drive:write",    "description": "Upload, share, delete files." },
        { "scope": "notes:read",     "description": "Read notes." },
        { "scope": "notes:write",    "description": "Create / update / delete notes." },
        { "scope": "tasks:read",     "description": "Read tasks." },
        { "scope": "tasks:write",    "description": "Create / update / delete tasks." },
        { "scope": "ai:use",         "description": "Send prompts to the assistant." },
        { "scope": "admin",          "description": "Tenant administration (members, keys, billing). Issued only to internal keys." },
        { "scope": "*",              "description": "Full access. Only available to internal keys, gated to the platform owner." }
    ])
}
