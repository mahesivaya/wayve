// Visual layer for the call state machine. Rendered both by the standalone
// [Call](./Call.tsx) page and inside [Chat](../chat/Chat.tsx) so the same
// banners/active panel appear regardless of where the user kicked off (or
// answered) the call.
//
// The host component owns the [useCallSession](./useCallSession.ts) hook
// and passes its output straight through — this component is pure UI.

import { useEffect, useState } from "react";
import type { CallSession } from "./useCallSession";
import "./call.css";

type Props = {
  session: CallSession;
};

// mm:ss elapsed since the call went active.
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const ss = (total % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function CallOverlays({ session }: Props) {
  const {
    callState,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleVideo,
    remoteAudioRef,
    remoteVideoRef,
    localVideoRef,
  } = session;

  // Tick once a second while a call is active to drive the duration display.
  // No synchronous reset on start: `now` is stale-but-earlier than a fresh
  // `startedAt`, so `formatElapsed` clamps the first frame to 00:00 until the
  // interval's first tick a second later.
  const startedAt = callState.kind === "active" ? callState.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <>
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
              {callState.media === "video" ? "Video" : "Audio"} call · waiting
              for answer
            </span>
          </div>
          <button className="call-btn call-btn-reject" onClick={endCall}>
            Cancel
          </button>
        </div>
      )}

      {callState.kind === "active" && (
        <div className="call-active">
          <header className="call-active-header">
            <span>
              In {callState.media === "video" ? "video" : "audio"} call with{" "}
              <strong>{callState.peerEmail}</strong>
            </span>
            <span className="call-active-timer">
              {formatElapsed(now - callState.startedAt)}
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
            {callState.media === "video" && (
              <button
                className={`call-btn ${
                  callState.videoOff ? "call-btn-muted" : ""
                }`}
                onClick={toggleVideo}
              >
                {callState.videoOff ? "Camera On" : "Camera Off"}
              </button>
            )}
            <button className="call-btn call-btn-reject" onClick={endCall}>
              End Call
            </button>
          </div>
        </div>
      )}
    </>
  );
}
