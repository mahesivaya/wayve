use crate::prelude::*;
use crate::ws_registry::{ConnId, SessionRegistry};
use actix::*;
use actix_web_actors::ws;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::{debug, info, instrument, warn};
use wayve_security::rbac;

use crate::models::callmodel::SignalMessage;

static SESSIONS: Lazy<SessionRegistry<CallSession>> = Lazy::new(SessionRegistry::new);

// Same liveness scheme as chat: a server ping every HEARTBEAT_INTERVAL, and a
// socket silent past CLIENT_TIMEOUT is dropped as dead. Without it a vanished
// client lingered until nginx's 1h proxy_read_timeout.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

// Scope metadata captured at connect so the forwarder can refuse cross-scope
// signaling without a DB hit. This is the server-side enforcement behind the
// directory filter in `routes/user.rs::get_all_users`; without it a client could
// craft a `call-invite` for any user_id and bypass the UI.
#[derive(Clone, Copy)]
struct CallerScope {
    scope: rbac::Scope,
    organization_id: Option<i32>,
}

static CALLER_SCOPES: Lazy<Mutex<HashMap<i32, CallerScope>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn lookup_caller_scope(user_id: i32) -> Option<CallerScope> {
    let guard = CALLER_SCOPES.lock().unwrap_or_else(|e| e.into_inner());
    guard.get(&user_id).copied()
}

fn record_caller_scope(user_id: i32, info: CallerScope) {
    let mut guard = CALLER_SCOPES.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(user_id, info);
}

fn drop_caller_scope(user_id: i32) {
    let mut guard = CALLER_SCOPES.lock().unwrap_or_else(|e| e.into_inner());
    guard.remove(&user_id);
}

// The relay is otherwise stateless. This is the minimum per-call state needed to
// emit one audit row, with talk-time duration, when a call resolves, and to keep
// a call pinned to the one tab or device on each side that is actually in it.
#[derive(Clone)]
struct CallInfo {
    caller: i32,
    callee: i32,
    media: String,
    connected: bool,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The connection that placed the call.
    caller_conn: ConnId,
    /// The connection that answered. `None` while ringing, when every one of the
    /// callee's tabs and devices rings.
    callee_conn: Option<ConnId>,
}

impl CallInfo {
    /// Where a signal for `peer`, the other party, should go.
    fn route_to(&self, peer: i32) -> Route {
        if peer == self.caller {
            Route::Conn(peer, self.caller_conn)
        } else {
            match self.callee_conn {
                Some(conn) => Route::Conn(peer, conn),
                None => Route::AllOf(peer),
            }
        }
    }

    /// Whether `conn` is the connection `me` is in this call on. While ringing,
    /// any of the callee's connections counts.
    fn is_my_conn(&self, me: i32, conn: ConnId) -> bool {
        if me == self.caller {
            self.caller_conn == conn
        } else {
            self.callee_conn.is_none_or(|bound| bound == conn)
        }
    }

    fn outcome_when_ended(&self) -> &'static str {
        if self.connected {
            "completed"
        } else {
            "missed"
        }
    }
}

// Keyed by the unordered (min, max) user pair so either party's signal resolves
// the same in-flight call.
type Calls = HashMap<(i32, i32), CallInfo>;
static ACTIVE_CALLS: Lazy<Mutex<Calls>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn call_key(a: i32, b: i32) -> (i32, i32) {
    (a.min(b), a.max(b))
}

/// Which of a user's connections receive a signal.
#[derive(Debug, PartialEq)]
enum Route {
    /// Every connection the user has (ringing, or no tracked call).
    AllOf(i32),
    /// Just the connection that is in the call.
    Conn(i32, ConnId),
    /// Dropped: a stale signal from a tab that isn't in the call.
    Nowhere,
}

/// What to do with one inbound signal.
#[derive(Debug, PartialEq)]
struct Plan {
    forward: Route,
    /// Stop the sender's other connections ringing (`call-cancel` from the peer):
    /// the call was answered or declined on this one.
    cancel_my_others: bool,
    /// Stop this connection ringing: the call was already answered elsewhere.
    cancel_me: bool,
    audit: Option<(CallInfo, &'static str)>,
}

impl std::fmt::Debug for CallInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CallInfo({}->{})", self.caller, self.callee)
    }
}

impl PartialEq for CallInfo {
    fn eq(&self, other: &Self) -> bool {
        self.caller == other.caller && self.callee == other.callee
    }
}

fn forward(route: Route) -> Plan {
    Plan {
        forward: route,
        cancel_my_others: false,
        cancel_me: false,
        audit: None,
    }
}

/// Decide routing and call-state changes for `signal`, sent by `me` on
/// connection `my_conn`. Pure over `calls`, so the multi-tab rules are
/// unit-testable without sockets.
fn plan_signal(calls: &mut Calls, me: i32, my_conn: ConnId, signal: &SignalMessage) -> Plan {
    let kind = signal.r#type.as_str();
    let peer = signal.to;
    let media = signal.media.as_deref();
    let key = call_key(me, peer);

    if kind == "call-invite" {
        calls.insert(
            key,
            CallInfo {
                caller: me,
                callee: peer,
                media: media.unwrap_or("audio").to_string(),
                connected: false,
                started_at: None,
                caller_conn: my_conn,
                callee_conn: None,
            },
        );
        // Ring every tab and device the callee has.
        return forward(Route::AllOf(peer));
    }

    // Signals outside a tracked call keep the old broadcast behaviour.
    let Some(info) = calls.get_mut(&key) else {
        return forward(Route::AllOf(peer));
    };

    match kind {
        "call-accept" if me == info.callee => match info.callee_conn {
            None => {
                info.callee_conn = Some(my_conn);
                info.connected = true;
                info.started_at = Some(chrono::Utc::now());
                Plan {
                    forward: info.route_to(peer),
                    cancel_my_others: true,
                    cancel_me: false,
                    audit: None,
                }
            }
            Some(bound) if bound == my_conn => forward(info.route_to(peer)),
            // Answered on another tab or device first: this one stops ringing.
            Some(_) => Plan {
                forward: Route::Nowhere,
                cancel_my_others: false,
                cancel_me: true,
                audit: None,
            },
        },
        "call-reject" | "call-cancel" | "call-end" => {
            if !info.is_my_conn(me, my_conn) {
                return forward(Route::Nowhere);
            }
            let route = info.route_to(peer);
            let outcome = if kind == "call-reject" {
                "rejected"
            } else {
                info.outcome_when_ended()
            };
            // A decline while ringing stops the callee's other tabs ringing too.
            let cancel_my_others = me == info.callee && info.callee_conn.is_none();
            let audit = calls.remove(&key).map(|ended| (ended, outcome));
            Plan {
                forward: route,
                cancel_my_others,
                cancel_me: false,
                audit,
            }
        }
        // offer / answer / ice-candidate: only between the two connections in
        // the call.
        _ if info.is_my_conn(me, my_conn) => forward(info.route_to(peer)),
        _ => forward(Route::Nowhere),
    }
}

/// A call the closing connection was part of, and how to tell the other party.
struct Finalized {
    info: CallInfo,
    outcome: &'static str,
    /// Signal kind + recipient so the other side stops ringing. `None` for a
    /// connected call: its media is peer-to-peer and may outlive a signaling
    /// blip, and the other side's own `call-end` still reaches this user's
    /// connections once the call is untracked.
    notify: Option<(&'static str, Route)>,
}

/// Resolve the calls affected by `user` closing connection `conn`. `last` is
/// whether that was the user's last call connection.
fn plan_disconnect(calls: &mut Calls, user: i32, conn: ConnId, last: bool) -> Vec<Finalized> {
    let keys: Vec<(i32, i32)> = calls
        .iter()
        .filter(|(_, info)| {
            (info.caller == user && info.caller_conn == conn)
                || (info.callee == user && info.callee_conn == Some(conn))
                // Ringing, and nowhere left to ring.
                || (info.callee == user && info.callee_conn.is_none() && last)
        })
        .map(|(key, _)| *key)
        .collect();
    keys.into_iter()
        .filter_map(|key| calls.remove(&key))
        .map(|info| {
            let outcome = info.outcome_when_ended();
            let notify = if info.connected {
                None
            } else if info.caller == user {
                Some(("call-cancel", info.route_to(info.callee)))
            } else {
                Some(("call-reject", info.route_to(info.caller)))
            };
            Finalized {
                info,
                outcome,
                notify,
            }
        })
        .collect()
}

fn record_call_audit(pool: PgPool, info: CallInfo, outcome: &'static str) {
    let duration = info
        .started_at
        .map(|started| (chrono::Utc::now() - started).num_seconds().max(0));
    actix::spawn(async move {
        let peer_email: Option<String> =
            sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
                .bind(info.callee)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
        let mut metadata = serde_json::json!({
            "media": info.media,
            "outcome": outcome,
            "peer_id": info.callee,
            "peer_email": peer_email,
        });
        if let Some(seconds) = duration {
            metadata["duration_seconds"] = serde_json::json!(seconds);
        }
        crate::audit::record_action_system(
            &pool,
            crate::audit::AuditEvent {
                actor_user_id: info.caller,
                action: "call",
                resource_type: "call",
                resource_id: None,
                metadata: Some(metadata),
            },
        )
        .await;
    });
}

/// The live connections a route resolves to.
fn resolve(route: &Route) -> Vec<Addr<CallSession>> {
    match route {
        Route::AllOf(user) => SESSIONS.addrs(*user),
        Route::Conn(user, conn) => SESSIONS.addr(*user, *conn).into_iter().collect(),
        Route::Nowhere => Vec::new(),
    }
}

/// A server-originated control signal, e.g. `call-cancel` "from" the peer so the
/// client's `peerId === from` guard accepts it.
fn control(kind: &str, from: i32, to: i32) -> SignalMessage {
    SignalMessage {
        r#type: kind.to_string(),
        to,
        from: Some(from),
        sdp: None,
        candidate: None,
        media: None,
        from_email: None,
    }
}

// Scopes must match, and organization users must also share an org_id, so users
// in different organizations can never call each other.
fn can_call_between(from: CallerScope, to: CallerScope) -> bool {
    use rbac::Scope::*;
    match (from.scope, to.scope) {
        (Personal, Personal) => true,
        (Platform, Platform) => true,
        (Organization, Organization) => {
            from.organization_id.is_some() && from.organization_id == to.organization_id
        }
        _ => false,
    }
}

pub struct CallSession {
    pub user_id: i32,
    pub scope: rbac::Scope,
    pub organization_id: Option<i32>,
    pub pool: PgPool,
    // This connection's registry id, set on start. A user may hold several.
    pub conn_id: ConnId,
    // Drives dead-client detection.
    pub last_seen: Instant,
}

impl Actor for CallSession {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        info!(
            target: "ws",
            user_id = self.user_id,
            scope = self.scope.as_str(),
            "Call WS connected"
        );
        self.conn_id = SESSIONS.register(self.user_id, ctx.address());
        self.last_seen = Instant::now();
        record_caller_scope(
            self.user_id,
            CallerScope {
                scope: self.scope,
                organization_id: self.organization_id,
            },
        );

        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.last_seen) > CLIENT_TIMEOUT {
                warn!(target: "ws", user_id = act.user_id, "call WS heartbeat timeout — closing dead client");
                ctx.stop();
                return;
            }
            ctx.ping(b"");
        });
    }

    fn stopped(&mut self, _: &mut Self::Context) {
        info!(target: "ws", user_id = self.user_id, "Call WS disconnected");
        let last = SESSIONS.unregister(self.user_id, self.conn_id);
        // Other tabs or devices still need the scope to place and take calls.
        if last {
            drop_caller_scope(self.user_id);
        }
        let finalized = {
            let mut calls = ACTIVE_CALLS.lock().unwrap_or_else(|e| e.into_inner());
            plan_disconnect(&mut calls, self.user_id, self.conn_id, last)
        };
        for done in finalized {
            if let Some((kind, route)) = &done.notify {
                let peer = if done.info.caller == self.user_id {
                    done.info.callee
                } else {
                    done.info.caller
                };
                for addr in resolve(route) {
                    addr.do_send(control(kind, self.user_id, peer));
                }
            }
            record_call_audit(self.pool.clone(), done.info, done.outcome);
        }
    }
}

impl Handler<SignalMessage> for CallSession {
    type Result = ();

    fn handle(&mut self, msg: SignalMessage, ctx: &mut Self::Context) {
        match serde_json::to_string(&msg) {
            Ok(text) => ctx.text(text),
            Err(e) => warn!(target: "ws", error = %e, "failed to serialize signal message"),
        }
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for CallSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        // Any valid frame proves the client is alive.
        if msg.is_ok() {
            self.last_seen = Instant::now();
        }
        match msg {
            Ok(ws::Message::Text(text)) => {
                debug!(target: "ws", user_id = self.user_id, len = text.len(), "call signal in");

                if let Ok(signal) = serde_json::from_str::<SignalMessage>(&text) {
                    let target = signal.to;

                    // Plan before the scope gate so declines and cancels are
                    // audited even when forwarding is refused.
                    let plan = {
                        let mut calls = ACTIVE_CALLS.lock().unwrap_or_else(|e| e.into_inner());
                        plan_signal(&mut calls, self.user_id, self.conn_id, &signal)
                    };
                    if let Some((info, outcome)) = plan.audit {
                        record_call_audit(self.pool.clone(), info, outcome);
                    }
                    // The user's own tabs: no scope gate needed.
                    if plan.cancel_my_others {
                        for (_, addr) in SESSIONS.others(self.user_id, self.conn_id) {
                            addr.do_send(control("call-cancel", target, self.user_id));
                        }
                    }
                    if plan.cancel_me {
                        ctx.address()
                            .do_send(control("call-cancel", target, self.user_id));
                    }

                    // The target must be connected and in a scope the caller can
                    // reach, so a crafted signal for any other user_id is dropped.
                    let target_scope = lookup_caller_scope(target);
                    let from_scope = CallerScope {
                        scope: self.scope,
                        organization_id: self.organization_id,
                    };
                    match target_scope {
                        Some(ts) if can_call_between(from_scope, ts) => {}
                        Some(_) => {
                            warn!(
                                target: "ws",
                                from = self.user_id,
                                to = target,
                                from_scope = from_scope.scope.as_str(),
                                "refusing cross-scope call signal"
                            );
                            return;
                        }
                        None => {
                            warn!(target: "ws", target_user = target, "signal target not connected");
                            return;
                        }
                    }

                    let recipients = resolve(&plan.forward);
                    debug!(target: "ws", from = self.user_id, to = target, kind = %signal.r#type, connections = recipients.len(), "forwarding signal");
                    for addr in recipients {
                        addr.do_send(SignalMessage {
                            r#type: signal.r#type.clone(),
                            to: signal.to,
                            from: Some(self.user_id),
                            sdp: signal.sdp.clone(),
                            candidate: signal.candidate.clone(),
                            media: signal.media.clone(),
                            from_email: signal.from_email.clone(),
                        });
                    }
                } else {
                    warn!(target: "ws", user_id = self.user_id, "failed to parse signal message");
                }
            }

            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Pong(_)) => {}
            Ok(ws::Message::Close(_)) => {
                debug!(target: "ws", user_id = self.user_id, "call client closed");
                ctx.stop();
            }

            _ => {}
        }
    }
}

#[instrument(target = "ws", skip(req, stream, query, pool))]
pub async fn call_ws(
    req: HttpRequest,
    stream: web::Payload,
    query: web::Query<HashMap<String, String>>,
    pool: web::Data<PgPool>,
) -> Result<HttpResponse, Error> {
    // Invariant: user_id comes from verified credentials only. The ?token=
    // fallback is decoded and verified, never trusted as a raw query value.
    let user_id = match wayve_security::jwt::get_user_id_from_request(&req).or_else(|| {
        query
            .get("token")
            .cloned()
            .filter(|token| !token.trim().is_empty())
            .and_then(|token| wayve_security::jwt::decode_jwt(&token))
            .map(|claims| claims.sub)
    }) {
        Some(id) => id,
        None => {
            warn!(target: "ws", "call_ws rejected: missing or invalid credentials");
            return Ok(HttpResponse::Unauthorized().body("Missing or invalid credentials"));
        }
    };

    // Resolve scope up front so signaling is gated without per-message DB hits.
    // Fails closed: an unresolvable user cannot be placed in any scope.
    let ctx = match rbac::resolve_role_context(pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(e) => {
            warn!(target: "ws", error = ?e, user_id, "call_ws scope resolution failed");
            return Ok(HttpResponse::Unauthorized().body("Could not resolve account scope"));
        }
    };

    info!(
        target: "ws",
        user_id,
        scope = ctx.scope.as_str(),
        "Call WS connect"
    );

    ws::start(
        CallSession {
            user_id,
            scope: ctx.scope,
            organization_id: ctx.organization_id,
            pool: pool.get_ref().clone(),
            conn_id: 0,
            last_seen: Instant::now(),
        },
        &req,
        stream,
    )
}

#[cfg(test)]
mod tests {
    use super::{Calls, Route, SignalMessage, control, plan_disconnect, plan_signal};

    fn sig(calls: &mut Calls, me: i32, conn: u64, kind: &str, peer: i32) -> super::Plan {
        let mut signal: SignalMessage = control(kind, me, peer);
        signal.media = Some("video".to_string());
        plan_signal(calls, me, conn, &signal)
    }

    const CALLER: i32 = 1;
    const CALLEE: i32 = 2;

    fn ringing(calls: &mut Calls) {
        let plan = sig(calls, CALLER, 10, "call-invite", CALLEE);
        assert_eq!(
            plan.forward,
            Route::AllOf(CALLEE),
            "invite rings every callee tab"
        );
    }

    #[test]
    fn answer_binds_one_tab_and_stops_the_others() {
        let mut calls = Calls::new();
        ringing(&mut calls);

        let plan = sig(&mut calls, CALLEE, 21, "call-accept", CALLER);
        assert_eq!(
            plan.forward,
            Route::Conn(CALLER, 10),
            "only the placing tab"
        );
        assert!(
            plan.cancel_my_others,
            "the callee's other tabs stop ringing"
        );

        // A second tab answering late is told to stop instead of joining.
        let late = sig(&mut calls, CALLEE, 22, "call-accept", CALLER);
        assert_eq!(late.forward, Route::Nowhere);
        assert!(late.cancel_me);

        // Media negotiation stays between the two bound connections.
        let offer = sig(&mut calls, CALLER, 10, "offer", CALLEE);
        assert_eq!(offer.forward, Route::Conn(CALLEE, 21));
        let stray = sig(&mut calls, CALLEE, 22, "ice-candidate", CALLER);
        assert_eq!(
            stray.forward,
            Route::Nowhere,
            "a tab outside the call can't inject"
        );
    }

    #[test]
    fn declining_on_one_tab_stops_every_tab_and_audits() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        let plan = sig(&mut calls, CALLEE, 22, "call-reject", CALLER);
        assert_eq!(plan.forward, Route::Conn(CALLER, 10));
        assert!(plan.cancel_my_others);
        assert!(matches!(plan.audit, Some((_, "rejected"))));
        assert!(calls.is_empty());
    }

    #[test]
    fn a_stale_tab_cannot_end_a_call_it_isnt_in() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        sig(&mut calls, CALLEE, 21, "call-accept", CALLER);

        let stale = sig(&mut calls, CALLEE, 22, "call-end", CALLER);
        assert_eq!(stale.forward, Route::Nowhere);
        assert!(stale.audit.is_none());
        assert_eq!(calls.len(), 1, "the call is still on");

        let end = sig(&mut calls, CALLEE, 21, "call-end", CALLER);
        assert_eq!(end.forward, Route::Conn(CALLER, 10));
        assert!(matches!(end.audit, Some((_, "completed"))));
    }

    #[test]
    fn caller_cancel_rings_down_every_callee_tab() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        let plan = sig(&mut calls, CALLER, 10, "call-cancel", CALLEE);
        assert_eq!(plan.forward, Route::AllOf(CALLEE));
        assert!(matches!(plan.audit, Some((_, "missed"))));
    }

    #[test]
    fn closing_an_idle_tab_leaves_the_call_alone() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        sig(&mut calls, CALLEE, 21, "call-accept", CALLER);

        assert!(plan_disconnect(&mut calls, CALLEE, 22, false).is_empty());
        assert!(plan_disconnect(&mut calls, CALLER, 11, false).is_empty());
        assert_eq!(calls.len(), 1);

        let done = plan_disconnect(&mut calls, CALLEE, 21, false);
        assert_eq!(done.len(), 1, "the tab in the call closing ends it");
        assert_eq!(done[0].outcome, "completed");
        assert!(
            done[0].notify.is_none(),
            "connected calls aren't torn down by a blip"
        );
    }

    #[test]
    fn ringing_ends_when_the_callee_has_nowhere_left_to_ring() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        assert!(
            plan_disconnect(&mut calls, CALLEE, 21, false).is_empty(),
            "another tab rings on"
        );
        let done = plan_disconnect(&mut calls, CALLEE, 22, true);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].outcome, "missed");
        assert_eq!(
            done[0].notify,
            Some(("call-reject", Route::Conn(CALLER, 10)))
        );
    }

    #[test]
    fn placing_tab_closing_while_ringing_rings_down_the_callee() {
        let mut calls = Calls::new();
        ringing(&mut calls);
        let done = plan_disconnect(&mut calls, CALLER, 10, false);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].notify, Some(("call-cancel", Route::AllOf(CALLEE))));
    }
}
