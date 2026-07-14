use crate::prelude::*;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

#[derive(Debug, Clone)]
pub struct AttachmentMeta {
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
}

pub fn extract_body(payload: &Value) -> Option<String> {
    // A `multipart/alternative` email carries the same content twice, plain
    // text first then HTML, so the whole tree must be scanned for HTML before
    // falling back to plain text. Taking the first matching part would always
    // yield the flattened text version.
    find_part_by_mime(payload, "text/html")
        .or_else(|| find_part_by_mime(payload, "text/plain"))
        // Last resort: a single-part message whose body.data sits at the top
        // level with an unusual or missing mimeType.
        .or_else(|| payload["body"]["data"].as_str().map(decode_base64))
}

fn find_part_by_mime(payload: &Value, want: &str) -> Option<String> {
    if payload["mimeType"].as_str() == Some(want)
        && let Some(data) = payload["body"]["data"].as_str()
    {
        return Some(decode_base64(data));
    }

    if let Some(parts) = payload["parts"].as_array() {
        for part in parts {
            if let Some(found) = find_part_by_mime(part, want) {
                return Some(found);
            }
        }
    }

    None
}

pub fn extract_attachments(payload: &Value) -> Vec<AttachmentMeta> {
    let mut attachments = Vec::new();
    collect_attachments(payload, &mut attachments);
    attachments
}

fn collect_attachments(payload: &Value, attachments: &mut Vec<AttachmentMeta>) {
    let filename = payload["filename"].as_str().unwrap_or("").trim();
    let attachment_id = payload["body"]["attachmentId"]
        .as_str()
        .unwrap_or("")
        .trim();

    if !filename.is_empty() && !attachment_id.is_empty() {
        attachments.push(AttachmentMeta {
            attachment_id: attachment_id.to_string(),
            filename: filename.to_string(),
            mime_type: payload["mimeType"].as_str().unwrap_or("").to_string(),
            size: payload["body"]["size"].as_i64().unwrap_or(0),
        });
    }

    if let Some(parts) = payload["parts"].as_array() {
        for part in parts {
            collect_attachments(part, attachments);
        }
    }
}

pub fn decode_base64(data: &str) -> String {
    let fixed = data.replace("-", "+").replace("_", "/");

    let decoded = STANDARD.decode(fixed).unwrap_or_default();

    String::from_utf8_lossy(&decoded).to_string()
}
