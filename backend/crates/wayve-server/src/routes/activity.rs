//! Client-side activity ingest: the frontend POSTs page views and UI clicks
//! here (fire-and-forget). API requests are captured separately by
//! `middleware::activity_log`. Both land in `activity_events` and surface on the
//! User Audit page.

use crate::prelude::*;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

const MAX_FIELD_LEN: usize = 300;

#[derive(Deserialize)]
pub struct ActivityInput {
    pub kind: String,
    pub label: Option<String>,
    pub path: Option<String>,
}

fn truncate(value: Option<String>) -> Option<String> {
    value.map(|mut s| {
        if s.chars().count() > MAX_FIELD_LEN {
            s = s.chars().take(MAX_FIELD_LEN).collect();
        }
        s
    })
}

#[post("/activity")]
#[instrument(target = "http", skip(req, data))]
pub async fn record_activity(req: HttpRequest, data: web::Json<ActivityInput>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // Clients may only record UI events; `api_request` is middleware-owned.
    let kind = match data.kind.as_str() {
        "page_view" => "page_view",
        "click" => "click",
        _ => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Unsupported activity kind" })));
        }
    };

    let mut row = crate::activity::ActivityRow::new(user_id, kind);
    row.label = truncate(data.label.clone());
    row.path = truncate(data.path.clone());
    row.ip = crate::audit::client_ip(&req);
    crate::activity::enqueue(row);

    Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true })))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(record_activity);
}
