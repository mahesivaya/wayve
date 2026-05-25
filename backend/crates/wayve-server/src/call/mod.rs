pub mod handler;
pub mod turn;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/ws/call", web::get().to(handler::call_ws));
}

// Mounted under `/api` in main.rs::app_routes. Kept separate from `routes`
// (which mounts the WS at the root) so the `/api/turn/...` endpoint gets the
// standard middleware chain (CORS, rate-limit, API-key) like other API calls.
pub fn api_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(turn::turn_credentials);
}
