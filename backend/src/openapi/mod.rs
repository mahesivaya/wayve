// Public OpenAPI 3.1 spec describing the API-key-callable surface of Wayve.
//
// Hand-curated rather than auto-generated: this surface is a long-term
// customer-facing contract, and it should NOT track every internal Actix
// route (which would expose admin/oauth/auth endpoints that are not meant
// for third-party consumption). The catalog of scopes here must stay in
// lockstep with `crate::security::api_key::required_scope` — both files
// describe the same gate, just for different audiences.

pub mod handler;

pub use handler::routes;
