import { createContext, useContext } from "react";
import type { CallSession } from "./useCallSession";

const noop = () => {};

// What a page sees with no CallProvider above it: nothing can ring or be started.
const IDLE_SESSION: CallSession = {
  callState: { kind: "idle" },
  connected: false,
  mediaError: null,
  dismissMediaError: noop,
  startCall: noop,
  acceptCall: noop,
  rejectCall: noop,
  endCall: noop,
  toggleMute: noop,
  toggleVideo: noop,
  remoteAudioRef: { current: null } as CallSession["remoteAudioRef"],
  remoteVideoRef: { current: null } as CallSession["remoteVideoRef"],
  localVideoRef: { current: null } as CallSession["localVideoRef"],
};

export const CallContext = createContext<CallSession>(IDLE_SESSION);

// The app's one call session; see CallProvider in CallContext.tsx.
export function useSharedCall(): CallSession {
  return useContext(CallContext);
}
