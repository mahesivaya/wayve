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
    // ICE/TURN credentials: canonical /api/call/credentials, legacy /api/turn/credentials.
    // The "turn" name leaks the underlying protocol; "call/credentials" reads as
    // "credentials for placing a call" regardless of WebRTC layer.
    cfg.route("/call/credentials", web::get().to(turn::turn_credentials))
        .route("/turn/credentials", web::get().to(turn::turn_credentials));
}
