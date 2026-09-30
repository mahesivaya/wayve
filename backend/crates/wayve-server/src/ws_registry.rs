//! Process-wide registry of live WebSocket sessions, keyed by user id and then by
//! connection.
//!
//! The chat and call actors both need to route messages to a connected user.
//! Generic over the actor type, so each feature gets one
//! `static Lazy<SessionRegistry<…>>` rather than its own `Mutex<HashMap<…>>` and
//! lock handling.
//!
//! A user can hold many connections at once (several tabs, a phone and a
//! laptop), so every connection gets its own id. Delivery goes to all of them,
//! and a connection that closes removes only itself. A single `user_id -> Addr`
//! slot used to let a second tab silently take delivery from the first, and let
//! any closing connection (including a stale one that outlived a reconnect)
//! wipe out the user's live one.

use actix::{Actor, Addr};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Identifies one connection within the process.
pub type ConnId = u64;

type Sessions<A> = HashMap<i32, HashMap<ConnId, Addr<A>>>;

pub struct SessionRegistry<A: Actor> {
    sessions: Mutex<Sessions<A>>,
    next_id: AtomicU64,
}

impl<A: Actor> SessionRegistry<A> {
    /// An empty registry. Back a `static` with `Lazy::new(SessionRegistry::new)`.
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Record a connected session alongside any others the user already has,
    /// returning the id to pass to [`unregister`](Self::unregister).
    pub fn register(&self, user_id: i32, addr: Addr<A>) -> ConnId {
        let conn_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.lock()
            .entry(user_id)
            .or_default()
            .insert(conn_id, addr);
        conn_id
    }

    /// Drop one connection on disconnect. Returns `true` when it was the user's
    /// last connection on this instance.
    pub fn unregister(&self, user_id: i32, conn_id: ConnId) -> bool {
        let mut sessions = self.lock();
        let Some(conns) = sessions.get_mut(&user_id) else {
            return true;
        };
        conns.remove(&conn_id);
        if conns.is_empty() {
            sessions.remove(&user_id);
            true
        } else {
            false
        }
    }

    /// Every live connection of a user. Cloned so the registry lock is released
    /// before the caller sends on them.
    pub fn addrs(&self, user_id: i32) -> Vec<Addr<A>> {
        self.lock()
            .get(&user_id)
            .map(|conns| conns.values().cloned().collect())
            .unwrap_or_default()
    }

    /// One specific connection of a user, if it is still live.
    pub fn addr(&self, user_id: i32, conn_id: ConnId) -> Option<Addr<A>> {
        self.lock().get(&user_id)?.get(&conn_id).cloned()
    }

    /// The user's live connections other than `except`, with their ids.
    pub fn others(&self, user_id: i32, except: ConnId) -> Vec<(ConnId, Addr<A>)> {
        self.lock()
            .get(&user_id)
            .map(|conns| {
                conns
                    .iter()
                    .filter(|(id, _)| **id != except)
                    .map(|(id, addr)| (*id, addr.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether the user has at least one live connection on this instance.
    pub fn is_connected(&self, user_id: i32) -> bool {
        self.lock().contains_key(&user_id)
    }

    // Recover a poisoned lock rather than panicking: one crashed session task must
    // not take down presence for everyone else.
    fn lock(&self) -> MutexGuard<'_, Sessions<A>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl<A: Actor> Default for SessionRegistry<A> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix::Context;

    struct Dummy;
    impl Actor for Dummy {
        type Context = Context<Self>;
    }

    #[actix_web::test]
    async fn every_connection_is_kept_and_reachable() {
        let reg = SessionRegistry::<Dummy>::new();
        let a = reg.register(7, Dummy.start());
        let b = reg.register(7, Dummy.start());
        assert_ne!(a, b);
        assert_eq!(
            reg.addrs(7).len(),
            2,
            "a second tab must not replace the first"
        );
        assert!(reg.addr(7, a).is_some() && reg.addr(7, b).is_some());
        assert_eq!(reg.others(7, a).len(), 1);
        assert_eq!(reg.others(7, a)[0].0, b);
    }

    #[actix_web::test]
    async fn closing_one_connection_leaves_the_others() {
        let reg = SessionRegistry::<Dummy>::new();
        let old = reg.register(7, Dummy.start());
        let new = reg.register(7, Dummy.start());

        // A stale connection closing after a reconnect must not take the new one.
        assert!(!reg.unregister(7, old), "not the last connection");
        assert!(reg.is_connected(7));
        assert!(reg.addr(7, new).is_some());

        assert!(reg.unregister(7, new), "the last connection");
        assert!(!reg.is_connected(7));
        assert!(reg.addrs(7).is_empty());
    }

    #[actix_web::test]
    async fn unregister_is_idempotent_and_per_user() {
        let reg = SessionRegistry::<Dummy>::new();
        let mine = reg.register(1, Dummy.start());
        let theirs = reg.register(2, Dummy.start());
        assert!(reg.unregister(1, mine));
        assert!(reg.unregister(1, mine), "already gone reads as last");
        assert!(!reg.unregister(2, mine), "another user's id doesn't match");
        assert!(reg.addr(2, theirs).is_some());
    }
}
