// Platform team dashboards. Per-role aggregate endpoints feeding the
// role-specific landing pages (developer, support, ...). All endpoints gate
// on platform scope on top of the per-route permission so a tenant-scope
// holder of the same permission can't see cross-tenant aggregates.

pub mod handler;

pub use handler::routes;
