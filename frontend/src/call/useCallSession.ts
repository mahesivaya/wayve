// Single source of truth for the 1:1 calling lifecycle. Used by:
//   - The standalone /call page (legacy directory-driven entry point).
//   - The /chat page, where audio/video buttons in [ChatHeader](../chat/components/ChatHeader.tsx)
//     start a call against the currently-selected DM.
//
// The hook owns the /ws/call WebSocket, the RTCPeerConnection, local media
// tracks, and the state machine. Refs are returned so the caller can attach
// them to <audio> / <video> elements rendered wherever the call UI lives.
//
// Backend WS endpoints (/ws/chat and /ws/call) deliberately stay separate;
// merging them would mix two different protocols and complicate
// [ws_registry.rs](../../../backend/src/ws_registry.rs).

import { useCallback, useEffect, useRef, useState } from "react";
import { getIceServers } from "../api/turn";
import { getWsBase } from "../config/env";
import { logger } from "../utils/logger";

const log = logger.scope("call");

// Signaling envelope shared with the backend `models::callmodel::SignalMessage`.
// `media` is only set on `call-invite`; `from_email` lets the callee render
// the caller's identity without hitting the directory.
export type CallSignal = {
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

export type CallMedia = "audio" | "video";

// Call lifecycle. Media negotiation deliberately stays out of the directory
// phase — the offer/answer dance only starts after the callee taps Accept.
export type CallState =
  | { kind: "idle" }
  | { kind: "outgoing"; peerId: number; peerEmail: string; media: CallMedia }
  | { kind: "incoming"; peerId: number; peerEmail: string; media: CallMedia }
  | {
      kind: "active";
      peerId: number;
      peerEmail: string;
      media: CallMedia;
      muted: boolean;
    };

export interface CallSession {
  callState: CallState;
  connected: boolean;
  startCall: (peerId: number, peerEmail: string, media: CallMedia) => void;
  acceptCall: () => void;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  remoteAudioRef: React.RefObject<HTMLAudioElement | null>;
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
}

// ICE servers (STUN + TURN) are fetched per-call from `/api/turn/credentials`
// — see [getIceServers](../api/turn.ts). The backend proxies Cloudflare's
// `generate-ice-servers` so the long-lived API token never reaches the
// browser. If the endpoint is unreachable or unconfigured, the helper
// returns a STUN-only fallback so calls still work between permissive NATs.

// Outgoing calls auto-cancel after this if the callee never picks up.
const RING_TIMEOUT_MS = 30_000;

export function useCallSession(
  myId: number | null,
  myEmail: string | undefined,
): CallSession {
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const ringTimerRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [callState, setCallState] = useState<CallState>({ kind: "idle" });

  const sendSignal = useCallback((signal: CallSignal) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn("dropping signal — WS not open", signal.type);
      return;
    }
    ws.send(JSON.stringify(signal));
  }, []);

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

  const buildPeerConnection = useCallback(
    async (peerId: number, media: CallMedia): Promise<RTCPeerConnection> => {
      // Fetch fresh ICE config (includes Cloudflare TURN credentials when
      // configured) before instantiating the PC — required for relay
      // candidates to be discovered during the initial ICE gather pass.
      const iceServers = await getIceServers();
      const pc = new RTCPeerConnection({ iceServers });

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

  const attachLocalMedia = useCallback(
    async (pc: RTCPeerConnection, media: CallMedia) => {
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

  const startCall = useCallback(
    (peerId: number, peerEmail: string, media: CallMedia) => {
      if (callState.kind !== "idle") return;
      setCallState({ kind: "outgoing", peerId, peerEmail, media });
      sendSignal({
        type: "call-invite",
        to: peerId,
        media,
        // The backend overrides `from` with the authenticated user id;
        // `from_email` is purely informational so the callee can render us.
        from_email: myEmail,
      });

      ringTimerRef.current = window.setTimeout(() => {
        log.warn("ring timeout — no answer from", peerEmail);
        sendSignal({ type: "call-cancel", to: peerId });
        teardownPeer();
        setCallState({ kind: "idle" });
      }, RING_TIMEOUT_MS);
    },
    [callState.kind, sendSignal, teardownPeer, myEmail],
  );

  const acceptCall = useCallback(async () => {
    if (callState.kind !== "incoming") return;
    const { peerId, peerEmail, media } = callState;
    try {
      const pc = await buildPeerConnection(peerId, media);
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

  const rejectCall = useCallback(() => {
    if (callState.kind !== "incoming") return;
    sendSignal({ type: "call-reject", to: callState.peerId });
    setCallState({ kind: "idle" });
  }, [callState, sendSignal]);

  const endCall = useCallback(() => {
    if (callState.kind === "idle") return;
    const exitType: CallSignal["type"] =
      callState.kind === "outgoing" ? "call-cancel" : "call-end";
    sendSignal({ type: exitType, to: callState.peerId });
    teardownPeer();
    setCallState({ kind: "idle" });
  }, [callState, sendSignal, teardownPeer]);

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

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      const from = signal.from;
      if (typeof from !== "number") return;

      switch (signal.type) {
        case "call-invite": {
          if (callState.kind !== "idle") {
            // We're busy — auto-reject so the caller's UI doesn't hang.
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
          if (callState.kind !== "outgoing" || callState.peerId !== from) return;
          if (ringTimerRef.current !== null) {
            window.clearTimeout(ringTimerRef.current);
            ringTimerRef.current = null;
          }
          try {
            const pc = await buildPeerConnection(from, callState.media);
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

  // One WS for the lifetime of the host component. Auth lives in the cookie
  // (or query token for legacy clients) — see [chat_ws](../../../backend/src/chat/websocket.rs).
  // Tear down on unmount so a route change doesn't leak the connection.
  useEffect(() => {
    if (myId === null) return;
    const ws = new WebSocket(`${getWsBase()}/ws/call`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const signal = JSON.parse(event.data) as CallSignal;
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
    // lifetime of the host and re-bind onmessage in the effect below
    // when the closure changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  // Re-bind the message handler whenever the closure (which captures
  // call state) changes — without this, the WS would call a stale handler
  // and miss state transitions.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.onmessage = (event) => {
      try {
        const signal = JSON.parse(event.data) as CallSignal;
        void handleSignal(signal);
      } catch (err) {
        log.error("failed to parse signal", err);
      }
    };
  }, [handleSignal]);

  // Attach the local stream to the preview <video> the moment the active
  // call UI mounts the element. `attachLocalMedia` runs BEFORE setCallState
  // flips to "active", so `localVideoRef.current` is null at capture time
  // and the inline `srcObject = stream` assignment there silently no-ops.
  // Without this effect, the user sees a black self-preview rectangle for
  // the whole call even though their camera is being captured and sent.
  useEffect(() => {
    if (callState.kind !== "active" || callState.media !== "video") return;
    const el = localVideoRef.current;
    const stream = localStreamRef.current;
    if (el && stream) {
      el.srcObject = stream;
    }
  }, [callState]);

  return {
    callState,
    connected,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    remoteAudioRef,
    remoteVideoRef,
    localVideoRef,
  };
}
