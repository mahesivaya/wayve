// The one call session for the whole app. An incoming call has to reach someone on
// any page, and a call has to survive navigating away, so the session sits above
// the routes and renders its own overlays. Chat and /call read it from here rather
// than opening sockets of their own, which would ring twice in one tab.

import { useEffect, type ReactNode } from "react";
import { useAuth } from "../auth/useAuth";
import {
  appInFocus,
  closeDesktopNotification,
  showDesktopNotification,
} from "../components/desktopNotifications";
import { alertEnabled } from "../components/notificationPrefs";
import {
  primeNotificationSound,
  startRingtone,
  stopRingtone,
} from "../components/notificationSound";
import CallOverlays from "./CallOverlays";
import { useCallSession, type CallSession } from "./useCallSession";
import { CallContext } from "./useSharedCall";

// Rings for as long as a call is incoming, in whichever way this device allows. The
// ring is unconditional on focus, as a call is worth interrupting for; the
// notification is only for when the in-app banner might go unseen.
function useIncomingCallAlerts({ callState }: CallSession) {
  const incoming = callState.kind === "incoming" ? callState : null;
  const peerId = incoming?.peerId;
  const peerEmail = incoming?.peerEmail;
  const media = incoming?.media;

  useEffect(() => {
    if (peerId === undefined) return;
    const tag = `call:${peerId}`;
    if (alertEnabled("calls", "sound")) startRingtone();
    if (alertEnabled("calls", "notification") && !appInFocus()) {
      showDesktopNotification(
        `Incoming ${media === "video" ? "video" : "audio"} call`,
        peerEmail ?? "",
        tag
      );
    }
    return () => {
      stopRingtone();
      closeDesktopNotification(tag);
    };
  }, [peerId, peerEmail, media]);
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const session = useCallSession(user?.id ?? null, user?.email);
  useIncomingCallAlerts(session);
  useEffect(() => primeNotificationSound(), []);

  return (
    <CallContext.Provider value={session}>
      {children}
      <div className="call-global">
        <CallOverlays session={session} />
      </div>
    </CallContext.Provider>
  );
}
