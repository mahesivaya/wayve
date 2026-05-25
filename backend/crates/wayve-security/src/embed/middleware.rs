/// Principal stamped on a request authenticated by an embed token.
/// Defined here (rather than in the embed middleware that constructs
/// instances of it) so the central auth chokepoint
/// `crate::jwt::get_user_id_from_request` can resolve it from
/// `request.extensions()` without depending back on wayve-server.
///
/// `TypeId`-based lookups across crates only match when both sides
/// reference the same type definition, so the middleware in
/// wayve-server inserts an instance of THIS exact struct.
#[derive(Debug, Clone)]
pub struct EmbedPrincipal {
    pub user_id: i32,
    /// Permitted scopes from the token. Currently advisory — v1 enforces
    /// GET-only at the method layer; per-route scope gating arrives if a
    /// consumer mints tokens narrower than "all reads".
    pub scopes: Vec<String>,
    /// Per-token nonce for log correlation.
    pub jti: String,
}
