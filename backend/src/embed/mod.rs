// Embed tokens.
//
// Short-lived (5 min) JWTs issued to embed Wayve's read-only product
// surfaces inside a customer's own iframe. Distinct from session JWTs:
//   * narrow scope set (read-only by contract)
//   * audience pinned to a specific Origin
//   * separate `iss` claim — the legacy `decode_jwt` won't honor them
//   * a dedicated middleware accepts the header `X-EMBED-TOKEN`,
//     refuses non-GET methods, and pins to the declared origin
//
// v1 is intentionally bare: no DB table for token tracking, no revocation
// (rotate by waiting 5 min). Add storage when a customer needs immediate
// revocation.

pub mod handler;
pub mod middleware;
pub mod tokens;

pub use handler::routes;
