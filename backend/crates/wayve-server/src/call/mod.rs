pub mod handler;
pub mod turn;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/ws/call", web::get().to(handler::call_ws));
}

// Mounted under `/api`, separately from `routes`, which mounts the WS at the
// root, so these endpoints get the standard middleware chain.
pub fn api_routes(cfg: &mut web::ServiceConfig) {
    // `/call/credentials` is canonical; `/turn/credentials` is the legacy alias.
    cfg.route("/call/credentials", web::get().to(turn::turn_credentials))
        .route("/turn/credentials", web::get().to(turn::turn_credentials));
}
