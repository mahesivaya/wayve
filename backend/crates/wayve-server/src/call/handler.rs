use crate::prelude::*;
use crate::ws_registry::SessionRegistry;
use actix::*;
use actix_web_actors::ws;
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::{debug, info, instrument, warn};
use wayve_security::rbac;

use crate::models::callmodel::SignalMessage;

static SESSIONS: Lazy<SessionRegistry<CallSession>> = Lazy::new(SessionRegistry::new);

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
// emit one audit row, with talk-time duration, when a call resolves.
#[derive(Clone)]
struct CallInfo {
    caller: i32,
    callee: i32,
    media: String,
    connected: bool,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
}

// Keyed by the unordered (min, max) user pair so either party's signal resolves
// the same in-flight call.
type ActiveCalls = Mutex<HashMap<(i32, i32), CallInfo>>;
static ACTIVE_CALLS: Lazy<ActiveCalls> = Lazy::new(|| Mutex::new(HashMap::new()));

fn call_key(a: i32, b: i32) -> (i32, i32) {
    (a.min(b), a.max(b))
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

fn track_call_lifecycle(pool: &PgPool, me: i32, signal_type: &str, peer: i32, media: Option<&str>) {
    let key = call_key(me, peer);
    let resolved = {
        let mut guard = ACTIVE_CALLS.lock().unwrap_or_else(|e| e.into_inner());
        match signal_type {
            "call-invite" => {
                guard.insert(
                    key,
                    CallInfo {
                        caller: me,
                        callee: peer,
                        media: media.unwrap_or("audio").to_string(),
                        connected: false,
                        started_at: None,
                    },
                );
                None
            }
            "call-accept" => {
                if let Some(info) = guard.get_mut(&key) {
                    info.connected = true;
                    info.started_at = Some(chrono::Utc::now());
                }
                None
            }
            "call-reject" => guard.remove(&key).map(|info| (info, "rejected")),
            "call-cancel" | "call-end" => guard.remove(&key).map(|info| {
                let outcome = if info.connected {
                    "completed"
                } else {
                    "missed"
                };
                (info, outcome)
            }),
            _ => None,
        }
    };
    if let Some((info, outcome)) = resolved {
        record_call_audit(pool.clone(), info, outcome);
    }
}

// Finalize any in-flight call this user was part of when their socket drops
// without an explicit end signal.
fn finalize_calls_for(pool: &PgPool, user_id: i32) {
    let orphaned = {
        let mut guard = ACTIVE_CALLS.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<(i32, i32)> = guard
            .iter()
            .filter(|(_, info)| info.caller == user_id || info.callee == user_id)
            .map(|(key, _)| *key)
            .collect();
        keys.into_iter()
            .filter_map(|key| guard.remove(&key))
            .collect::<Vec<_>>()
    };
    for info in orphaned {
        let outcome = if info.connected {
            "completed"
        } else {
            "missed"
        };
        record_call_audit(pool.clone(), info, outcome);
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
        SESSIONS.register(self.user_id, ctx.address());
        record_caller_scope(
            self.user_id,
            CallerScope {
                scope: self.scope,
                organization_id: self.organization_id,
            },
        );
    }

    fn stopped(&mut self, _: &mut Self::Context) {
        info!(target: "ws", user_id = self.user_id, "Call WS disconnected");
        SESSIONS.unregister(self.user_id);
        drop_caller_scope(self.user_id);
        finalize_calls_for(&self.pool, self.user_id);
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
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, _: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Text(text)) => {
                debug!(target: "ws", user_id = self.user_id, len = text.len(), "call signal in");

                if let Ok(signal) = serde_json::from_str::<SignalMessage>(&text) {
                    let target = signal.to;

                    // Audit the call lifecycle before the scope gate so declines
                    // and cancels are recorded even when forwarding is refused.
                    track_call_lifecycle(
                        &self.pool,
                        self.user_id,
                        &signal.r#type,
                        target,
                        signal.media.as_deref(),
                    );

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

                    if let Some(addr) = SESSIONS.addr(target) {
                        debug!(target: "ws", from = self.user_id, to = target, kind = %signal.r#type, "forwarding signal");

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

            Ok(ws::Message::Close(_)) => {
                debug!(target: "ws", user_id = self.user_id, "call client closed");
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
        },
        &req,
        stream,
    )
}
