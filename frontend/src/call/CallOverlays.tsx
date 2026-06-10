// Visual layer for the call state machine. Rendered both by the standalone
// [Call](./Call.tsx) page and inside [Chat](../chat/Chat.tsx) so the same
// banners/active panel appear regardless of where the user kicked off (or
// answered) the call.
//
// The host component owns the [useCallSession](./useCallSession.ts) hook
// and passes its output straight through — this component is pure UI.

import type { CallSession } from "./useCallSession";
import "./call.css";

type Props = {
  session: CallSession;
};

export default function CallOverlays({ session }: Props) {
  const {
    callState,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    remoteAudioRef,
    remoteVideoRef,
    localVideoRef,
  } = session;

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
      )}
    </>
  );
}
