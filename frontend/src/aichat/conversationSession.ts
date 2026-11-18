// The AI chat conversation, kept for the life of the browser tab so a refresh
// (or leaving the page and coming back) doesn't wipe it. sessionStorage, like
// the other "what was open" memories: it ends with the tab, and AuthContext
// forgets it on logout and session expiry so the next person to sign in on
// this tab never sees it. It is stored under the user it belongs to and only
// handed back to that same user.

const STORAGE_KEY = "wayve-ai-chat-conversation";

type Stored<T> = { userId: number; conversation: T };

export function loadAiConversation<T>(userId: number | undefined): T | null {
  if (userId == null) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored<T>;
    return stored.userId === userId ? stored.conversation : null;
  } catch {
    return null;
  }
}

export function saveAiConversation<T>(
  userId: number | undefined,
  conversation: T
): void {
  if (userId == null) return;
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ userId, conversation } satisfies Stored<T>)
    );
  } catch {
    // ignore — private mode / quota
  }
}

export function forgetAiConversation(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
