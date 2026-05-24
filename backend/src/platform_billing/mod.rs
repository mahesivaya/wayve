// Platform-admin billing console. Aggregates the per-tenant Stripe projection
// (user + organization subscriptions, invoices, MRR) with payroll. Distinct
// from `billing/` — that module is per-tenant self-service; this one is the
// staff-only console gated by platform-scope billing:read / billing:manage.

pub mod handler;

pub use handler::routes;
