import type { EmailFolder } from "./types";

// Which email is open outlives the Emails page: every route change unmounts it,
// and the sidebar's /emails link carries no `?open=`, so without this coming back
// from Chat lands on the list. Ids only, never message content. sessionStorage
// outlives a logout within the tab, so the entry names its owner and AuthContext
// clears it on logout and session expiry.
const STORAGE_KEY = "rwayve.emails.open";

export type OpenEmailSession = {
  userId: number;
  emailId: number;
  // The view it was opened from, so the list behind it is the same one.
  account: number | null;
  folder: EmailFolder;
};

export function readOpenEmail(
  userId: number | undefined
): OpenEmailSession | null {
  if (userId === undefined) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenEmailSession> | null;
    if (
      !parsed ||
      parsed.userId !== userId ||
      typeof parsed.emailId !== "number" ||
      typeof parsed.folder !== "string"
    ) {
      return null;
    }
    return {
      userId,
      emailId: parsed.emailId,
      account: typeof parsed.account === "number" ? parsed.account : null,
      folder: parsed.folder,
    };
  } catch {
    return null;
  }
}

export function rememberOpenEmail(open: OpenEmailSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // private mode / quota — the email just won't reopen on return.
  }
}

export function forgetOpenEmail(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
