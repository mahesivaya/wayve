import { useSyncExternalStore } from "react";

// How many Chat views are mounted right now: the routed /chat page or a split
// pane. While any is open it owns the chat socket and shows messages itself, so
// the app-wide message popups stand down.
let openCount = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

/** Called by a mounting Chat view. Returns the cleanup for its unmount. */
export function markChatOpen(): () => void {
  openCount += 1;
  notify();
  return () => {
    openCount = Math.max(0, openCount - 1);
    notify();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const isOpen = () => openCount > 0;

/** True while any Chat view is on screen. */
export function useChatViewOpen(): boolean {
  return useSyncExternalStore(subscribe, isOpen, isOpen);
}
