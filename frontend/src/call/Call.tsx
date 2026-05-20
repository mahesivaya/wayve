import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetchJson } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { getWsBase } from "../config/env";
import { logger } from "../utils/logger";
import "./call.css";

const log = logger.scope("call");

// Signaling envelope shared with backend `models::callmodel::SignalMessage`.
// `media` is set on `call-invite`; `from_email` lets the callee render the
// caller's identity without a directory lookup.
type Signal = {
  type:
    | "call-invite"
    | "call-accept"
    | "call-reject"
    | "call-cancel"
    | "call-end"
    | "offer"
    | "answer"
    | "ice-candidate";
  to: number;
  from?: number;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  media?: "audio" | "video";
  from_email?: string;
};

type DirectoryUser = {
  id: number;
  email: string;
};

// Call lifecycle. We keep media negotiation OUT of the directory phase —
// the offer/answer dance only starts after the callee taps Accept.
type CallState =
  | { kind: "idle" }
  | { kind: "outgoing"; peerId: number; peerEmail: string; media: "audio" | "video" }
  | { kind: "incoming"; peerId: number; peerEmail: string; media: "audio" | "video" }
  | { kind: "active"; peerId: number; peerEmail: string; media: "audio" | "video"; muted: boolean };

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// Outgoing calls auto-cancel after this if the callee never picks up.
const RING_TIMEOUT_MS = 30_000;

export default function Call() {
  const { user } = useAuth();
  const myId = user?.id ?? null;

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const ringTimerRef = useRef<number | null>(null);

  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [callState, setCallState] = useState<CallState>({ kind: "idle" });
  const [search, setSearch] = useState("");

  // ─────────────────────────────────────────────────────────────
  // Send a signal through the WS (no-op if socket isn't ready).
  // ─────────────────────────────────────────────────────────────
  const sendSignal = useCallback((signal: Signal) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn("dropping signal — WS not open", signal.type);
      return;
    }
    ws.send(JSON.stringify(signal));
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Teardown peer connection + local media tracks.
  // ─────────────────────────────────────────────────────────────
  const teardownPeer = useCallback(() => {
    if (ringTimerRef.current !== null) {
      window.clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Build the RTCPeerConnection on demand. Same peer is reused for
  // the lifetime of one call; teardown nulls it.
  // ─────────────────────────────────────────────────────────────
  const buildPeerConnection = useCallback(
    (peerId: number, media: "audio" | "video"): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: "ice-candidate",
            to: peerId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        if (media === "video" && remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
        } else if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendSignal],
  );

  // ─────────────────────────────────────────────────────────────
  // Attach local mic (+ camera) to the peer connection.
  // ─────────────────────────────────────────────────────────────
  const attachLocalMedia = useCallback(
    async (pc: RTCPeerConnection, media: "audio" | "video") => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: media === "video",
      });
      localStreamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      if (media === "video" && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    },
    [],
  );

  // ─────────────────────────────────────────────────────────────
  // Caller side: I want to call <peer>. Show "Ringing…" until the
  // callee accepts (then we send the offer) or the timer expires.
  // ─────────────────────────────────────────────────────────────
  const startCall = useCallback(
    (peer: DirectoryUser, media: "audio" | "video") => {
      if (callState.kind !== "idle") return;
      setCallState({ kind: "outgoing", peerId: peer.id, peerEmail: peer.email, media });
      sendSignal({
        type: "call-invite",
        to: peer.id,
        media,
        // Pass our own email so the callee's UI can identify us.
        // The backend overrides `from` with the authenticated user_id;
        // `from_email` is informational only.
        from_email: user?.email,
      });

      ringTimerRef.current = window.setTimeout(() => {
        log.warn("ring timeout — no answer from", peer.email);
        sendSignal({ type: "call-cancel", to: peer.id });
        teardownPeer();
        setCallState({ kind: "idle" });
      }, RING_TIMEOUT_MS);
    },
    [callState.kind, sendSignal, teardownPeer, user?.email],
  );

  // ─────────────────────────────────────────────────────────────
  // Callee side: I tap Accept on an incoming call. Build the peer,
  // attach my mic, and tell the caller we're ready — they will
  // create the offer.
  // ─────────────────────────────────────────────────────────────
  const acceptCall = useCallback(async () => {
    if (callState.kind !== "incoming") return;
    const { peerId, peerEmail, media } = callState;
    try {
      const pc = buildPeerConnection(peerId, media);
      await attachLocalMedia(pc, media);
      sendSignal({ type: "call-accept", to: peerId });
      setCallState({ kind: "active", peerId, peerEmail, media, muted: false });
    } catch (err) {
      log.error("acceptCall failed", err);
      sendSignal({ type: "call-reject", to: peerId });
      teardownPeer();
      setCallState({ kind: "idle" });
    }
  }, [callState, buildPeerConnection, attachLocalMedia, sendSignal, teardownPeer]);

  // ─────────────────────────────────────────────────────────────
  // Callee side: decline an incoming call.
  // ─────────────────────────────────────────────────────────────
  const rejectCall = useCallback(() => {
    if (callState.kind !== "incoming") return;
    sendSignal({ type: "call-reject", to: callState.peerId });
    setCallState({ kind: "idle" });
  }, [callState, sendSignal]);

  // ─────────────────────────────────────────────────────────────
  // End/cancel the current call from either side. Sends the right
  // signal for the lifecycle stage, then resets to idle.
  // ─────────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    if (callState.kind === "idle") return;
    const exitType: Signal["type"] =
      callState.kind === "outgoing" ? "call-cancel" : "call-end";
    sendSignal({ type: exitType, to: callState.peerId });
    teardownPeer();
    setCallState({ kind: "idle" });
  }, [callState, sendSignal, teardownPeer]);

  // ─────────────────────────────────────────────────────────────
  // Toggle mute on the local audio track.
  // ─────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (callState.kind !== "active") return;
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !callState.muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setCallState({ ...callState, muted: next });
  }, [callState]);

  // ─────────────────────────────────────────────────────────────
  // Handle incoming signal messages from the relay.
  // ─────────────────────────────────────────────────────────────
  const handleSignal = useCallback(
    async (signal: Signal) => {
      const from = signal.from;
      if (typeof from !== "number") return;

      switch (signal.type) {
        case "call-invite": {
          // Ignore second invite if we're already busy.
          if (callState.kind !== "idle") {
            sendSignal({ type: "call-reject", to: from });
            return;
          }
          setCallState({
            kind: "incoming",
            peerId: from,
            peerEmail: signal.from_email ?? `user #${from}`,
            media: signal.media ?? "audio",
          });
          return;
        }

        case "call-accept": {
          // Caller side: callee picked up. Now create the offer.
          if (callState.kind !== "outgoing" || callState.peerId !== from) return;
          if (ringTimerRef.current !== null) {
            window.clearTimeout(ringTimerRef.current);
            ringTimerRef.current = null;
          }
          try {
            const pc = buildPeerConnection(from, callState.media);
            await attachLocalMedia(pc, callState.media);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ type: "offer", to: from, sdp: offer.sdp });
            setCallState({
              kind: "active",
              peerId: from,
              peerEmail: callState.peerEmail,
              media: callState.media,
              muted: false,
            });
          } catch (err) {
            log.error("caller side accept handling failed", err);
            sendSignal({ type: "call-end", to: from });
            teardownPeer();
            setCallState({ kind: "idle" });
          }
          return;
        }

        case "call-reject":
        case "call-cancel":
        case "call-end": {
          if (callState.kind === "idle") return;
          if (callState.peerId !== from) return;
          teardownPeer();
          setCallState({ kind: "idle" });
          return;
        }

        case "offer": {
          // Callee side: caller is sending us their SDP after we accepted.
          const pc = pcRef.current;
          if (!pc || !signal.sdp) return;
          try {
            await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: "answer", to: from, sdp: answer.sdp });
          } catch (err) {
            log.error("offer handling failed", err);
          }
          return;
        }

        case "answer": {
          const pc = pcRef.current;
          if (!pc || !signal.sdp) return;
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
          } catch (err) {
            log.error("answer handling failed", err);
          }
          return;
        }

        case "ice-candidate": {
          const pc = pcRef.current;
          if (!pc || !signal.candidate) return;
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (err) {
            log.error("ice candidate failed", err);
          }
          return;
        }
      }
    },
    [callState, buildPeerConnection, attachLocalMedia, sendSignal, teardownPeer],
  );

  // ─────────────────────────────────────────────────────────────
  // WS lifecycle. We keep one connection open while on the page so
  // we can receive incoming-call invites at any time.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(`${getWsBase()}/ws/call`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const signal = JSON.parse(event.data) as Signal;
        void handleSignal(signal);
      } catch (err) {
        log.error("failed to parse signal", err);
      }
    };

    return () => {
      ws.close();
      teardownPeer();
    };
    // handleSignal closes over state; we want one stable WS for the
    // lifetime of the page and re-bind the message handler when the
    // closure changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-bind the message handler whenever the closure (which captures
  // call state) changes — without this, the WS would keep calling a
  // stale handler and miss state transitions.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.onmessage = (event) => {
      try {
        const signal = JSON.parse(event.data) as Signal;
        void handleSignal(signal);
      } catch (err) {
        log.error("failed to parse signal", err);
      }
    };
  }, [handleSignal]);

  // ─────────────────────────────────────────────────────────────
  // Load directory of callable users (tenant-scoped on the backend).
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    apiFetchJson<DirectoryUser[]>("/api/users/all")
      .then((rows) => {
        if (cancelled) return;
        setUsers(rows.filter((u) => u.id !== myId));
      })
      .catch((err) => {
        if (cancelled) return;
        log.error("user directory load failed", err);
        setUsersError("Failed to load users");
      });
    return () => {
      cancelled = true;
    };
  }, [myId]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, search]);

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="call-page">
      <header className="call-page-header">
        <h2>Calls</h2>
        <span className={`call-conn ${connected ? "ok" : "down"}`}>
          {connected ? "Connected" : "Offline"}
        </span>
      </header>

      {callState.kind === "incoming" && (
        <div className="call-banner call-banner-incoming" role="alertdialog">
          <div className="call-banner-text">
            <strong>{callState.peerEmail}</strong>
            <span>
              Incoming {callState.media === "video" ? "video" : "audio"} call
            </span>
          </div>
          <div className="call-banner-actions">
            <button className="call-btn call-btn-accept" onClick={acceptCall}>
              Accept
            </button>
            <button className="call-btn call-btn-reject" onClick={rejectCall}>
              Reject
            </button>
          </div>
        </div>
      )}

      {callState.kind === "outgoing" && (
        <div className="call-banner call-banner-outgoing" role="status">
          <div className="call-banner-text">
            <strong>Calling {callState.peerEmail}…</strong>
            <span>
              {callState.media === "video" ? "Video" : "Audio"} call · waiting for answer
            </span>
          </div>
          <button className="call-btn call-btn-reject" onClick={endCall}>
            Cancel
          </button>
        </div>
      )}

      {callState.kind === "active" ? (
        <div className="call-active">
          <header className="call-active-header">
            <span>
              In {callState.media === "video" ? "video" : "audio"} call with{" "}
              <strong>{callState.peerEmail}</strong>
            </span>
          </header>

          {callState.media === "video" && (
            <div className="call-video-stage">
              <video
                ref={remoteVideoRef}
                className="call-video-remote"
                autoPlay
                playsInline
              />
              <video
                ref={localVideoRef}
                className="call-video-local"
                autoPlay
                playsInline
                muted
              />
            </div>
          )}

          <audio ref={remoteAudioRef} autoPlay />

          <div className="call-active-controls">
            <button
              className={`call-btn ${callState.muted ? "call-btn-muted" : ""}`}
              onClick={toggleMute}
            >
              {callState.muted ? "Unmute" : "Mute"}
            </button>
            <button className="call-btn call-btn-reject" onClick={endCall}>
              End Call
            </button>
          </div>
        </div>
      ) : (
        <div className="call-directory">
          <input
            type="search"
            className="call-search"
            placeholder="Search by email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {usersError && <p className="call-error">{usersError}</p>}

          {!usersError && filteredUsers.length === 0 && (
            <p className="call-empty">No users to call.</p>
          )}

          <ul className="call-user-list">
            {filteredUsers.map((u) => {
              const disabled = callState.kind !== "idle" || !connected;
              return (
                <li key={u.id} className="call-user-row">
                  <div className="call-user-identity">
                    <div className="call-user-avatar" aria-hidden>
                      {u.email.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="call-user-email">{u.email}</span>
                  </div>
                  <div className="call-user-actions">
                    <button
                      type="button"
                      className="call-btn call-btn-audio"
                      disabled={disabled}
                      onClick={() => startCall(u, "audio")}
                      aria-label={`Audio call ${u.email}`}
                    >
                      🔊 Audio
                    </button>
                    <button
                      type="button"
                      className="call-btn call-btn-video"
                      disabled={disabled}
                      onClick={() => startCall(u, "video")}
                      aria-label={`Video call ${u.email}`}
                    >
                      🎥 Video
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
