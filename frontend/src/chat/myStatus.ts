import { useEffect, useSyncExternalStore } from "react";
import { getPresence, setChatStatus, type ChatStatus } from "../api/chat";
import { logger } from "../utils/logger";

// The signed-in user's own chat status (Active, Do Not Disturb, Away), shared by
// every place that shows or sets it: the account menu on any page and the
// picker above the Chat page's search. One store keeps them in step; the
// server pushes a `presence` frame for your own id when it changes on another
// device, which the chat socket feeds in through `applyMyStatus`.

export const STATUS_OPTIONS: {
  value: ChatStatus;
  label: string;
  cls: string;
}[] = [
  { value: "active", label: "Active", cls: "online" },
  { value: "dnd", label: "Do Not Disturb", cls: "dnd" },
  { value: "away", label: "Away", cls: "away" },
];

export const statusLabel = (s: ChatStatus) =>
  STATUS_OPTIONS.find((o) => o.value === s)?.label ?? "Active";
export const statusClass = (s: ChatStatus) =>
  STATUS_OPTIONS.find((o) => o.value === s)?.cls ?? "online";

let current: ChatStatus = "active";
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function getMyStatus(): ChatStatus {
  return current;
}

export function subscribeMyStatus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Records a status that is already true on the server (a seed or a push). */
export function applyMyStatus(next: ChatStatus) {
  if (next === current) return;
  current = next;
  notify();
}

/** Reads the real status from the server (the presence snapshot has our row). */
export async function loadMyStatus(myUserId: number) {
  if (!myUserId) return;
  try {
    const rows = await getPresence([myUserId]);
    const mine = rows.find((r) => r.user_id === myUserId);
    if (mine?.status) applyMyStatus(mine.status);
  } catch {
    // Best-effort: keep what we have (default "active").
  }
}

/** Sets it: shown at once, saved on the server, put back if that fails. */
export async function chooseMyStatus(next: ChatStatus) {
  if (next === current) return;
  const prev = current;
  applyMyStatus(next);
  try {
    await setChatStatus(next);
  } catch (err) {
    logger.error("set chat status failed", err);
    applyMyStatus(prev);
  }
}

/** The current status, seeded from the server once per mount. */
export function useMyStatus(myUserId: number | null | undefined): ChatStatus {
  useEffect(() => {
    if (myUserId) void loadMyStatus(myUserId);
  }, [myUserId]);
  return useSyncExternalStore(subscribeMyStatus, getMyStatus, getMyStatus);
}

/** For tests: back to the default. */
export function resetMyStatusForTests() {
  current = "active";
  notify();
}
