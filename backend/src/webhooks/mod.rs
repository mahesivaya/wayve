// Outbound webhook subscriptions.
//
// Customers subscribe to platform events; the dispatcher worker delivers a
// signed JSON envelope to the registered URL. Retry policy is 3 attempts at
// 0s, 1m, 5m. Endpoints that consecutively fail are auto-disabled.
//
// The wire format and event-type catalog are a long-term contract: renaming
// `task.created` later breaks every customer integration. Treat additions
// as backwards-compatible and avoid removal once an event has shipped.

pub mod dispatcher;
pub mod events;
pub mod handler;

pub use dispatcher::spawn_dispatcher;
pub use events::{Event, emit};
pub use handler::routes;
