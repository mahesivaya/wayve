// Single source of truth for the 1-on-1 calling lifecycle, run once for the whole
// app by CallProvider (see CallContext.tsx). Calls are peer-to-peer with no media
// server, so 1-on-1 only. The hook owns the /ws/call WebSocket (signaling relay
// only), the RTCPeerConnection, local media tracks, and the state machine; the
// returned refs are attached to <audio>/<video> elements by whichever UI renders
// the call. /ws/chat and /ws/call stay separate protocols.

import { useCallback, useEffect, useRef, useState } from "react";
import { getIceServers } from "../api/turn";
import { getWsBase } from "../config/env";
import { logger } from "../utils/logger";

const log = logger.scope("call");

// Must stay in sync with the backend `models::callmodel::SignalMessage`. `media` is
// only set on `call-invite`; `from_email` lets the callee render the caller's
// identity without hitting the directory.
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

// The offer/answer exchange only starts once the callee taps Accept, so no media
// is negotiated while the call is merely ringing.
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
      // The track stays in the PeerConnection and only `track.enabled` flips, so no
      // renegotiation is needed; the peer receives black frames until re-enabled.
      videoOff: boolean;
      // Epoch ms, for the elapsed-time display.
      startedAt: number;
    };

export interface CallSession {
  callState: CallState;
  connected: boolean;
  // Why the mic/camera couldn't be opened, shown until dismissed or the next try.
  mediaError: string | null;
  dismissMediaError: () => void;
  startCall: (peerId: number, peerEmail: string, media: CallMedia) => void;
  acceptCall: () => void;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  remoteAudioRef: React.RefObject<HTMLAudioElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  localVideoRef: React.RefObject<HTMLVideoElement>;
}

// ICE servers are fetched per call from `/api/turn/credentials`; the backend proxies
// Cloudflare so the long-lived API token never reaches the browser. If that endpoint
// is unreachable, getIceServers falls back to STUN only.

// Outgoing calls auto-cancel after this if the callee never picks up.
const RING_TIMEOUT_MS = 30_000;

// Triggers the browser's (or macOS's) camera/mic permission prompt.
// `mediaDevices` is missing outside a secure context (plain http).
async function requestLocalMedia(media: CallMedia): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("mediaDevices unavailable", "NotSupportedError");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: media === "video",
  });
}

export function describeMediaError(err: unknown, media: CallMedia): string {
  const devices = media === "video" ? "camera and microphone" : "microphone";
  // DOMException isn't an Error subclass in every runtime, so read `name` directly.
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return `Access to your ${devices} is blocked. Allow it in your browser's site settings (on a Mac, also System Settings › Privacy & Security), then try again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${devices} found. Connect one and try again.`;
    case "NotReadableError":
    case "AbortError":
      return `Your ${devices} is in use by another app. Close it and try again.`;
    case "NotSupportedError":
      return `Calls need a secure (https) connection to use your ${devices}.`;
    default:
      return `Couldn't open your ${devices}. Try again.`;
  }
}

export function useCallSession(
  myId: number | null,
  myEmail: string | undefined
): CallSession {
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const ringTimerRef = useRef<number | null>(null);
  // addIceCandidate() throws before the remote description is applied, so candidates
  // that arrive early are buffered here and flushed once setRemoteDescription resolves.
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  // Set while startCall waits on the permission prompt, so a second click
  // doesn't start a second call.
  const startingRef = useRef(false);
  // Bumped whenever the socket session is torn down (logout, user switch), so a
  // startCall that was waiting on the prompt knows not to resume.
  const sessionGenRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [callState, setCallState] = useState<CallState>({ kind: "idle" });
  const [mediaError, setMediaError] = useState<string | null>(null);
  const dismissMediaError = useCallback(() => setMediaError(null), []);

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
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pendingCandidatesRef.current = [];
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
      // Fetch ICE config before instantiating the PC, or relay candidates won't be
      // discovered during the initial gather pass.
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

      // A clean hang-up sends `call-end`, but an unclean drop (network loss, tab
      // close, crash) sends nothing and would leave the survivor on a frozen "active"
      // panel. The PeerConnection notices within seconds, so tear down locally.
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          log.warn("peer connection lost", pc.connectionState);
          teardownPeer();
          setCallState({ kind: "idle" });
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [sendSignal, teardownPeer]
  );

  // Must be called immediately after every setRemoteDescription.
  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        log.error("buffered ice candidate failed", err);
      }
    }
  }, []);

  // The caller already holds a stream from startCall (acquired before ringing);
  // the callee acquires one here, on Accept.
  const attachLocalMedia = useCallback(
    async (pc: RTCPeerConnection, media: CallMedia) => {
      const stream =
        localStreamRef.current ?? (await requestLocalMedia(media));
      localStreamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      if (media === "video" && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    },
    []
  );

  // Ask for the mic (and camera) before ringing anyone, so the permission prompt
  // shows when you press Call, and a blocked device never reaches the peer as a
  // call that dies the moment they pick up.
  const startCall = useCallback(
    async (peerId: number, peerEmail: string, media: CallMedia) => {
      if (callState.kind !== "idle" || startingRef.current) return;
      // The invite would be dropped, leaving a dead "Calling…" with the mic on.
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        setMediaError("Not connected to the call service. Try again in a moment.");
        return;
      }
      startingRef.current = true;
      setMediaError(null);
      const gen = sessionGenRef.current;
      let stream: MediaStream;
      try {
        stream = await requestLocalMedia(media);
      } catch (err) {
        log.error("could not get local media", err);
        setMediaError(describeMediaError(err, media));
        return;
      } finally {
        startingRef.current = false;
      }
      // Logged out (or switched user) while the prompt was open.
      if (gen !== sessionGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;
      setCallState({ kind: "outgoing", peerId, peerEmail, media });
      sendSignal({
        type: "call-invite",
        to: peerId,
        media,
        // The backend overrides `from` with the authenticated user id, so `from_email`
        // is informational only.
        from_email: myEmail,
      });

      ringTimerRef.current = window.setTimeout(() => {
        log.warn("ring timeout — no answer from", peerEmail);
        sendSignal({ type: "call-cancel", to: peerId });
        teardownPeer();
        setCallState({ kind: "idle" });
      }, RING_TIMEOUT_MS);
    },
    [callState.kind, sendSignal, teardownPeer, myEmail]
  );

  const acceptCall = useCallback(async () => {
    if (callState.kind !== "incoming") return;
    const { peerId, peerEmail, media } = callState;
    try {
      const pc = await buildPeerConnection(peerId, media);
      await attachLocalMedia(pc, media);
      sendSignal({ type: "call-accept", to: peerId });
      setCallState({
        kind: "active",
        peerId,
        peerEmail,
        media,
        muted: false,
        videoOff: false,
        startedAt: Date.now(),
      });
    } catch (err) {
      log.error("acceptCall failed", err);
      // getUserMedia rejects with a DOMException; anything else isn't a device issue.
      if (err instanceof DOMException) {
        setMediaError(describeMediaError(err, media));
      }
      sendSignal({ type: "call-reject", to: peerId });
      teardownPeer();
      setCallState({ kind: "idle" });
    }
  }, [
    callState,
    buildPeerConnection,
    attachLocalMedia,
    sendSignal,
    teardownPeer,
  ]);

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

  // Like mute, this flips `track.enabled` rather than removing the track, so no
  // renegotiation is needed.
  const toggleVideo = useCallback(() => {
    if (callState.kind !== "active" || callState.media !== "video") return;
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !callState.videoOff;
    stream.getVideoTracks().forEach((track) => {
      track.enabled = !next;
    });
    setCallState({ ...callState, videoOff: next });
  }, [callState]);

  const handleSignal = useCallback(
    async (signal: CallSignal) => {
      const from = signal.from;
      if (typeof from !== "number") return;

      switch (signal.type) {
        case "call-invite": {
          // Dialing out (permission prompt open) counts as busy too, or the
          // resumed startCall would overwrite this incoming call.
          if (callState.kind !== "idle" || startingRef.current) {
            // Busy: auto-reject so the caller's UI doesn't hang.
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
          if (callState.kind !== "outgoing" || callState.peerId !== from)
            return;
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
              videoOff: false,
              startedAt: Date.now(),
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
            await flushPendingCandidates(pc);
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
            await flushPendingCandidates(pc);
          } catch (err) {
            log.error("answer handling failed", err);
          }
          return;
        }

        case "ice-candidate": {
          const pc = pcRef.current;
          if (!pc || !signal.candidate) return;
          // Candidates can outrun the answer on the caller side, and addIceCandidate()
          // throws until the remote description is set, so buffer instead of dropping.
          if (!pc.remoteDescription) {
            pendingCandidatesRef.current.push(signal.candidate);
            return;
          }
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (err) {
            log.error("ice candidate failed", err);
          }
          return;
        }
      }
    },
    [
      callState,
      buildPeerConnection,
      attachLocalMedia,
      sendSignal,
      teardownPeer,
      flushPendingCandidates,
    ]
  );

  // The socket reads the handler through a ref: handleSignal closes over call
  // state and changes often, and every reconnected socket must use the latest.
  const handleSignalRef = useRef(handleSignal);
  useEffect(() => {
    handleSignalRef.current = handleSignal;
  }, [handleSignal]);

  // One WS for the lifetime of the host component, reconnected with backoff if it
  // drops (a network change, laptop sleep, a server restart); without that, the
  // tab silently stopped receiving calls until a reload. Torn down when the user
  // changes: the host outlives a logout, so it must not keep a call on screen.
  useEffect(() => {
    if (myId === null) return;
    let cancelled = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(`${getWsBase()}/ws/call`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        try {
          const signal = JSON.parse(event.data) as CallSignal;
          void handleSignalRef.current(signal);
        } catch (err) {
          log.error("failed to parse signal", err);
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        // Capped exponential backoff with ±20% jitter, as for the chat socket.
        attempts += 1;
        const base = Math.min(1000 * 2 ** (attempts - 1), 15000);
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        reconnectTimer = setTimeout(
          connect,
          Math.max(500, Math.round(base + jitter))
        );
      };
      // `onclose` fires right after and owns the reconnect scheduling.
      ws.onerror = () => {
        if (!cancelled) setConnected(false);
      };
    };

    connect();

    return () => {
      cancelled = true;
      sessionGenRef.current += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      teardownPeer();
      setConnected(false);
      setCallState({ kind: "idle" });
    };
    // teardownPeer is stable; the socket must not be rebuilt when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  // attachLocalMedia runs before setCallState flips to "active", so localVideoRef is
  // still null there and its inline srcObject assignment no-ops. This attaches the
  // stream once the active call UI has actually mounted the preview element.
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
    mediaError,
    dismissMediaError,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleVideo,
    remoteAudioRef,
    remoteVideoRef,
    localVideoRef,
  };
}
