//! Shared `?limit=…&offset=…` parsing for list endpoints.
//!
//! Today every list-style handler clamps its own limit:
//!   * `scim/handler.rs`        — `count.unwrap_or(100).clamp(1, 200)`
//!   * `routes/audit.rs`        — `.clamp(1, AUDIT_LOG_MAX_LIMIT)`
//!   * `routes/error_logs.rs`   — `.unwrap_or(200).clamp(1, 1000)`
//!   * `platform_billing/*`     — bespoke per-endpoint
//!
//! Defaults and ceilings drift across modules. New list endpoints can pull
//! this struct in via `web::Query` and call `.clamped(default, max)` to land
//! on a single style. Existing endpoints are intentionally not migrated —
//! adopt incrementally.
//!
//! Example:
//! ```ignore
//! #[derive(Deserialize)]
//! struct ListInput {
//!     #[serde(flatten)]
//!     page: PageQuery,
//!     // … filter fields …
//! }
//!
//! pub async fn list_things(query: web::Query<ListInput>) -> AppResult {
//!     let (limit, offset) = query.page.clamped(50, 200);
//!     // …
//! }
//! ```

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[allow(dead_code)]
pub struct PageQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[allow(dead_code)]
impl PageQuery {
    /// Returns `(limit, offset)` with `limit` clamped to `[1, max]` (using
    /// `default` when unset) and `offset >= 0`. Both are `i64` so callers
    /// can bind them directly into `sqlx::query!(..., LIMIT $1 OFFSET $2)`.
    pub fn clamped(&self, default: i64, max: i64) -> (i64, i64) {
        let limit = self.limit.unwrap_or(default).clamp(1, max);
        let offset = self.offset.unwrap_or(0).max(0);
        (limit, offset)
    }
}

#[cfg(test)]
mod tests {
    use super::PageQuery;

    #[test]
    fn defaults_when_unset() {
        let q = PageQuery::default();
        assert_eq!(q.clamped(50, 200), (50, 0));
    }

    #[test]
    fn caps_above_max() {
        let q = PageQuery {
            limit: Some(999_999),
            offset: Some(10),
        };
        assert_eq!(q.clamped(50, 200), (200, 10));
    }

    #[test]
    fn floors_at_one() {
        let q = PageQuery {
            limit: Some(0),
            offset: Some(-5),
        };
        assert_eq!(q.clamped(50, 200), (1, 0));
    }
}
