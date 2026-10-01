# 1-on-1 audio/video calling (WebRTC)

Peer-to-peer 1-on-1 audio and video calls over WebRTC. The two browsers stream
media **directly** to each other — the backend only relays signaling messages
and hands out ICE/TURN credentials; it never sees the audio/video. There is no
media server (no SFU/MCU), which is why this is strictly 1-on-1.

Zoom is **not** involved here. Zoom is used only for *scheduled* meetings
(`scheduler/zoom.rs` mints a `zoom_join_url`); ad-hoc live calls are entirely
WebRTC.

## Data flow

```
Caller (A)                       Backend /ws/call                 Callee (B)
   │  call-invite (media) ───────────▶ scope gate ──────────────────▶ ring UI
   │                                                          ◀─ Accept tapped
   │  ◀──────────────────────────────────────────────── call-accept ─┤
   │  (build PC, getUserMedia)                       (build PC, getUserMedia)
   │  offer (SDP) ───────────────────────────────────────────────────▶ setRemote
   │  ◀─────────────────────────────────────────────────── answer (SDP) ┤
   │  ◀──────── ice-candidate (trickle, both directions) ────────────▶ │
   │                                                                    │
   │  ◀═══════════════ media flows peer-to-peer (or via TURN) ════════▶ │
   │  call-end / call-cancel ─────────────────────────────────────────▶ teardown
```

The offer/answer dance deliberately starts **only after** the callee taps
Accept — `getUserMedia` (the camera/mic permission prompt) doesn't fire during
ringing.

## Components

| File | Responsibility |
| --- | --- |
| [backend/.../call/handler.rs](../../backend/crates/wayve-server/src/call/handler.rs) | `/ws/call` actor: auth, per-connection session registry, RBAC scope gate, multi-tab call routing, heartbeat, signal relay. |
| [backend/.../models/callmodel.rs](../../backend/crates/wayve-server/src/models/callmodel.rs) | `SignalMessage` envelope + `IceCandidate` (camelCase rename is load-bearing). |
| [backend/.../call/turn.rs](../../backend/crates/wayve-server/src/call/turn.rs) | Proxies Cloudflare to mint short-lived ICE/TURN credentials. |
| [frontend/.../call/useCallSession.ts](../../frontend/src/call/useCallSession.ts) | The whole client side: WS, `RTCPeerConnection`, media, and the call state machine. |
| [frontend/.../call/CallOverlays.tsx](../../frontend/src/call/CallOverlays.tsx) | Pure UI: incoming/outgoing banners + active-call panel (video, mute, camera, duration). |
| [frontend/.../call/Call.tsx](../../frontend/src/call/Call.tsx) | Standalone `/call` directory page. |
| [frontend/.../api/turn.ts](../../frontend/src/api/turn.ts) | Fetches + caches ICE servers, STUN-only fallback. |

## Signaling protocol

One envelope, discriminated by `type` (see `SignalMessage` / `CallSignal`). The
backend forwards every type unchanged except that it **overwrites `from`** with
the authenticated sender's user id (so identity can't be spoofed) and refuses to
deliver across scopes.

| `type` | Direction | Payload | Meaning |
| --- | --- | --- | --- |
| `call-invite` | A→B | `media` (`audio`/`video`), `from_email` | Ring B. |
| `call-accept` | B→A | — | B answered; A now creates the SDP offer. |
| `call-reject` | B→A | — | B declined (or was busy → auto-reject). |
| `call-cancel` | A→B | — | A hung up before B answered (or ring timed out, 30s). |
| `call-end` | either | — | Active call hung up. |
| `offer` / `answer` | A↔B | `sdp` | SDP negotiation. |
| `ice-candidate` | A↔B | `candidate` | Trickle ICE. |

**Client robustness** (in `useCallSession.ts`):

- ICE candidates that arrive before the remote description is applied are
  **buffered** and flushed after `setRemoteDescription`, rather than dropped —
  otherwise the caller can lose relay candidates and fail to connect.
- `onconnectionstatechange` → on `failed`/`disconnected` the UI tears down and
  returns to idle, so an unclean peer drop (network loss, tab close, crash) that
  never sends `call-end` doesn't leave the survivor on a frozen panel.

## Scope security (RBAC)

`call-invite` targets a `user_id`, so the relay must enforce who may call whom —
the UI directory filter alone is not trusted. At WS connect the user's scope is
resolved once (`resolve_role_context`) and cached; `can_call_between` then gates
every forwarded signal:

- **personal → personal**: allowed
- **platform → platform**: allowed
- **organization → organization**: allowed only within the **same** `organization_id`
- everything else: refused (logged, dropped)

## TURN / ICE configuration

Direct peer-to-peer works between permissive NATs with STUN alone, but symmetric
NATs need a TURN relay. The backend proxies Cloudflare so the long-lived API
token never reaches the browser:

| Env var | Purpose |
| --- | --- |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN key id. |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare API token (server-side only). |
| `CLOUDFLARE_TURN_TTL_SECONDS` | Credential lifetime (default 600s). |

If the first two are unset, `GET /api/call/credentials` returns **503** and the
client falls back to a public STUN server — calls still connect across
permissive NATs, just not symmetric ones. The client caches credentials per tab
for 8 minutes (under the 10-minute TTL).

## Entry points

- **`/call`** — standalone page: a tenant-scoped user directory with Audio/Video
  buttons.
- **Chat DM** — `ChatHeader` shows the same Audio/Video buttons for a 1:1
  conversation; both entry points share the single `useCallSession` hook.

## Multiple tabs and devices

Each call socket registers separately (see [ws_registry.rs](../../backend/crates/wayve-server/src/ws_registry.rs)),
and the relay pins each call to one connection per side:

- `call-invite` rings **every** tab and device of the callee.
- The first `call-accept` binds the call to that connection; the callee's other
  connections get `call-cancel` and stop ringing. A late accept from another tab
  is answered with `call-cancel`.
- A `call-reject` while ringing stops all of the callee's tabs.
- `offer` / `answer` / `ice-candidate` / `call-end` flow only between the two
  bound connections; signals from a tab outside the call are dropped.
- Closing an idle tab never touches a call. Closing the tab in a call ends its
  audit record; closing the placing tab while ringing rings the callee down, and
  a callee with nowhere left to ring sends the caller `call-reject`.
- The caller-scope entry is dropped only when the user's last call socket closes.

The routing rules are a pure function (`plan_signal` / `plan_disconnect` in
[call/handler.rs](../../backend/crates/wayve-server/src/call/handler.rs)) with unit
tests. The call socket has the chat socket's liveness too: a 25s server ping and
60s client timeout, and client reconnect with backoff in `useCallSession`.

## Limitations

- **1-on-1 only.** Adding a 3rd participant to a full mesh degrades fast; group
  calls would require an SFU (e.g. LiveKit / mediasoup) — a separate effort.
- **No recording.**
- **No call history / CDRs.** Signaling is ephemeral; nothing is persisted about
  who called whom or for how long.
