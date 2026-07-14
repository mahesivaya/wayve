// Outbound webhook subscriptions. Customers subscribe to platform events and
// the dispatcher worker delivers a signed JSON envelope to the registered URL,
// retrying at 0s, 1m, and 5m before auto-disabling a persistently failing
// endpoint.
//
// The wire format and event-type catalog are a long-term contract: renaming
// `task.created` breaks every customer integration. Additions are
// backwards-compatible; never remove an event once it has shipped.

pub mod dispatcher;
pub mod events;
pub mod handler;

pub use dispatcher::spawn_dispatcher;
pub use events::{Event, emit};
pub use handler::routes;
