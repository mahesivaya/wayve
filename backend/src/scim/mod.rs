// SCIM 2.0 service-provider implementation (Users only in v1).
//
// Per the RFC 7644 contract, requests authenticate with an organization-
// scoped bearer token (header `Authorization: Bearer <scim_token>`).
// Responses follow SCIM Core User schema (RFC 7643). Resources are
// scoped to the bearer's organization — there is no cross-org leakage
// even if an IdP misconfigures the URL.
//
// Out of scope for v1 (documented as gaps in the spec response):
//   * Groups
//   * PATCH operations (PUT replaces only)
//   * Complex filters — only `userName eq` and `externalId eq` are honored
//   * /Bulk

pub mod admin;
pub mod handler;
pub mod tokens;

pub use admin::routes as api_routes;
pub use handler::routes;
