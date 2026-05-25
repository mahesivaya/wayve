//! Embed-token middleware support. The middleware itself lives in
//! wayve-server (it builds Actix request transformers and reaches into
//! token-verification helpers that aren't part of this crate). What
//! lives here is the small `EmbedPrincipal` type the auth chokepoint
//! `jwt::get_user_id_from_request` looks up by `TypeId` from
//! `request.extensions()`.
//!
//! Defining the type in this crate is what lets the lookup resolve
//! without circling back to wayve-server. The wayve-server middleware
//! re-exports `EmbedPrincipal` so existing import paths stay intact.
pub mod middleware;
