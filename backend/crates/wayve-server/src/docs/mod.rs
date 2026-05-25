// Public /docs portal — serves an allowlisted set of Markdown files from
// the repository's `documentation/` directory.
//
// Allowlisting is deliberate: the same directory holds personal scratchpad
// notes (rotated keys, AWS account ids, internal IPs) that must never be
// published. The catalog here is the source of truth for what `/docs`
// exposes; adding a new file to `documentation/` does NOT publish it.

pub mod handler;

pub use handler::routes;
