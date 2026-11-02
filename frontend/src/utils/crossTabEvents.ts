// Change signals that reach every open tab of the app, not just this one.
//
// The data helpers announce a write as a plain window event ("this collection
// changed"), which only same-document listeners hear. `announceChange` also
// posts it on a BroadcastChannel, and each tab re-fires what it receives as the
// same window event, so existing `addEventListener(EVENT, …)` listeners pick up
// other tabs' writes with no changes of their own.
//
// A tab only hears the channel once it has opened it: `listenAcrossTabs` does
// that, and the always-mounted sidebar counts call it. Where BroadcastChannel is
// missing (old browsers), signals stay same-tab, as before.

const CHANNEL_NAME = "rwayve:changes";

let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    channel = null;
    return channel;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);
  // A channel never receives its own posts, so this only fires for other tabs.
  channel.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      window.dispatchEvent(new Event(event.data));
    }
  };
  return channel;
}

/** Fire `eventName` in this tab and every other open tab. */
export function announceChange(eventName: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(eventName));
  try {
    getChannel()?.postMessage(eventName);
  } catch {
    // A closed or failing channel only loses the cross-tab hop.
  }
}

/** Start re-firing other tabs' announcements in this tab. Idempotent. */
export function listenAcrossTabs(): void {
  getChannel();
}
