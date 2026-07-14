//! Embed-token support. The middleware itself lives in wayve-server; only the
//! `EmbedPrincipal` type lives here, so that `jwt::get_user_id_from_request` can
//! look it up out of `request.extensions()` without depending back on the app
//! crate. wayve-server re-exports the type.
pub mod middleware;
