/// Principal stamped on a request authenticated by an embed token.
///
/// It lives here, not beside the middleware that constructs it, because
/// extension lookups are keyed on `TypeId` and only match when both crates
/// reference the same definition. The wayve-server middleware must insert an
/// instance of this exact struct for `jwt::get_user_id_from_request` to find it.
#[derive(Debug, Clone)]
pub struct EmbedPrincipal {
    pub user_id: i32,
    /// Advisory only: enforcement today is GET-only at the method layer, not
    /// per-scope.
    pub scopes: Vec<String>,
    /// Per-token nonce for log correlation.
    pub jti: String,
}
