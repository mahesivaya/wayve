use crate::prelude::*;
use wayve_security::rbac;
use crate::ws_registry::SessionRegistry;
use actix::*;
use actix_web_actors::ws;
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::{debug, info, instrument, warn};

use crate::models::callmodel::SignalMessage;

static SESSIONS: Lazy<SessionRegistry<CallSession>> = Lazy::new(SessionRegistry::new);

// Per-connected-user scope metadata, populated at WS connect time so the
// per-message forwarder can refuse cross-scope signaling without a DB hit.
// A personal user can only call other personal users; an organization user
// only same-organization users; a platform user only other platform users.
// This is the server-side enforcement that backs the directory filter in
// `routes/user.rs::get_all_users` — without it a malicious client could
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

// Same-scope = OK. Organization additionally requires the same org_id so
// users in different organizations can never call each other.
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

                    // Scope gate: even if a malicious client crafts a signal
                    // for a user_id it shouldn't see in the directory, drop
                    // it here. The target must be (a) connected to the call
                    // WS and (b) in a scope the caller can reach.
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
    // Auth: an API key (resolved by ApiKeyMiddleware into the request
    // extensions) or a cookie/Bearer JWT, with a ?token= query fallback for
    // older clients.
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

    // Resolve scope up-front so signaling can be gated without per-message
    // DB hits. Fail closed on lookup error — a user that can't be resolved
    // cannot be safely placed in any scope.
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
        },
        &req,
        stream,
    )
}
