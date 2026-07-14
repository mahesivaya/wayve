//! Process-wide registry of live WebSocket sessions, keyed by user id.
//!
//! The chat and call actors both need a `user_id -> Addr` map to route messages
//! to a connected user. Generic over the actor type, so each feature gets one
//! `static Lazy<SessionRegistry<…>>` rather than its own `Mutex<HashMap<…>>` and
//! lock handling.

use actix::{Actor, Addr};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

pub struct SessionRegistry<A: Actor> {
    sessions: Mutex<HashMap<i32, Addr<A>>>,
}

impl<A: Actor> SessionRegistry<A> {
    /// An empty registry. Back a `static` with `Lazy::new(SessionRegistry::new)`.
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Record a connected session, replacing any prior `Addr` for this user.
    pub fn register(&self, user_id: i32, addr: Addr<A>) {
        self.lock().insert(user_id, addr);
    }

    /// Drop a session on disconnect.
    pub fn unregister(&self, user_id: i32) {
        self.lock().remove(&user_id);
    }

    /// The `Addr` of a connected user, if any. Cloned so the registry lock is
    /// released before the caller sends on it.
    pub fn addr(&self, user_id: i32) -> Option<Addr<A>> {
        self.lock().get(&user_id).cloned()
    }

    // Recover a poisoned lock rather than panicking: one crashed session task must
    // not take down presence for everyone else.
    fn lock(&self) -> MutexGuard<'_, HashMap<i32, Addr<A>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl<A: Actor> Default for SessionRegistry<A> {
    fn default() -> Self {
        Self::new()
    }
}
