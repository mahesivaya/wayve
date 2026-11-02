// What the chat window was showing outlives the Chat page: every route change
// unmounts it, and the sidebar's /chat link carries no `?dm=` / `?c=`, so without
// this coming back from Emails lands on an empty window. Ids and view state only,
// never message content. sessionStorage outlives a logout within the tab, so the
// entry names its owner and AuthContext clears it on logout and session expiry.
const STORAGE_KEY = "rwayve.chat.open";

export type OpenChatSession = {
  userId: number;
  // `dm:<userId>` or `c:<channelId>`, matching Chat's conversationKey.
  key: string;
  // A DM peer found by email may never be in the directory, so restoring looks
  // them up again by this.
  email: string | null;
  threadParentId: number | null;
  settingsOpen: boolean;
  scrollTop: number;
};

// Module memory rather than sessionStorage: a draft is the plaintext chat E2E
// exists to protect, and a File can't be serialized. It survives a route change
// but not a refresh.
export type ChatDraft = {
  userId: number;
  key: string;
  text: string;
  files: File[];
};

let draft: ChatDraft | null = null;

export function readOpenChat(
  userId: number | undefined
): OpenChatSession | null {
  if (userId === undefined) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenChatSession> | null;
    if (!parsed || parsed.userId !== userId || typeof parsed.key !== "string") {
      return null;
    }
    return {
      userId,
      key: parsed.key,
      email: typeof parsed.email === "string" ? parsed.email : null,
      threadParentId:
        typeof parsed.threadParentId === "number"
          ? parsed.threadParentId
          : null,
      settingsOpen: parsed.settingsOpen === true,
      scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
    };
  } catch {
    return null;
  }
}

export function rememberOpenChat(open: OpenChatSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // private mode / quota — the conversation just won't reopen on return.
  }
}

export function readChatDraft(
  userId: number | undefined,
  key: string
): ChatDraft | null {
  return draft && draft.userId === userId && draft.key === key ? draft : null;
}

export function rememberChatDraft(next: ChatDraft): void {
  draft = next;
}

export function forgetOpenChat(): void {
  draft = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
