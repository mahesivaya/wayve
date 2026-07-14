// SCIM 2.0 service provider (Users only in v1). Requests authenticate with an
// organization-scoped bearer token (`Authorization: Bearer <scim_token>`) and
// every resource is scoped to that bearer's organization, so a misconfigured
// IdP URL still cannot leak across orgs. Responses follow the RFC 7643 Core
// User schema. Not supported in v1: Groups, PATCH (PUT replaces), /Bulk, and
// filters other than `userName eq` / `externalId eq`.

pub mod admin;
pub mod handler;
pub mod tokens;

pub use admin::routes as api_routes;
pub use handler::routes;
