// Where you were in Code Repo outlives the page: every route change unmounts it,
// so without this coming back from Chat lands on the first repo's default branch.
// Names, numbers, paths, scroll offsets and half-written comments only, never file
// contents, and not a file's `download_url`, which carries a token for a private
// repo. sessionStorage outlives a logout within the tab, so the entry names its
// owner and AuthContext clears it on logout and session expiry.
const STORAGE_KEY = "rwayve.github.open";

// Each comes back with a request, so a long session can't turn returning into a
// burst of them. The most recently opened are kept.
const MAX_RESTORED_FOLDERS = 30;
const MAX_RESTORED_COMMITS = 10;
// No requests here, just a bound on what a long session stores.
const MAX_RESTORED_FILES = 200;
const MAX_SCROLL_PLACES = 50;

export type RepoView = {
  branch: string | null;
  pull: number | null;
  file: string | null;
  folders: string[];
  commits: string[];
  commitsPage: number;
  pullsPage: number;
  // Commit files folded away, and pull request files opened. Each is the
  // exception to that kind's default.
  collapsedFiles: string[];
  openPullFiles: string[];
  // Half-written conversation comments, by commit SHA and pull request number.
  commitDrafts: Record<string, string>;
  pullDrafts: Record<string, string>;
};

// A half-written comment on a line, or an edit of an existing comment.
export type CommentDraft = {
  body: string;
  anchor?: { side: "LEFT" | "RIGHT"; line: number; position: number };
};

export type DraftStore = {
  read: () => CommentDraft | null;
  save: (draft: CommentDraft) => void;
  clear: () => void;
};

type ScrollOffsets = Record<string, number>;

type OpenRepoSession = {
  userId: number;
  // A project id, or `owner/repo` on the platform page, which has no projects.
  repo: number | string | null;
  views: Record<string, RepoView>;
  drafts: Record<string, CommentDraft>;
  scrolls: Record<string, ScrollOffsets>;
};

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(-max)
    : [];

const page = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = <T>(value: unknown): Record<string, T> =>
  isRecord(value) ? (value as Record<string, T>) : {};

// Only what's still being written is worth keeping.
const draftTexts = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record<unknown>(value)).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1] !== ""
    )
  );

function readSession(userId: number): OpenRepoSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenRepoSession> | null;
    if (!parsed || parsed.userId !== userId) return null;
    return {
      userId,
      repo:
        typeof parsed.repo === "number" || typeof parsed.repo === "string"
          ? parsed.repo
          : null,
      views: record(parsed.views),
      drafts: record(parsed.drafts),
      scrolls: record(parsed.scrolls),
    };
  } catch {
    return null;
  }
}

function emptySession(userId: number): OpenRepoSession {
  return { userId, repo: null, views: {}, drafts: {}, scrolls: {} };
}

function writeSession(session: OpenRepoSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // private mode / quota — the page just opens fresh on return.
  }
}

export function readOpenRepo(
  userId: number | undefined
): number | string | null {
  if (userId === undefined) return null;
  return readSession(userId)?.repo ?? null;
}

export function rememberOpenRepo(
  userId: number | undefined,
  repo: number | string
): void {
  if (userId === undefined) return;
  writeSession({ ...(readSession(userId) ?? emptySession(userId)), repo });
}

export function readRepoView(
  userId: number | undefined,
  fullName: string
): RepoView | null {
  if (userId === undefined) return null;
  const views = readSession(userId)?.views;
  if (!views || !Object.hasOwn(views, fullName)) return null;
  const view = views[fullName] as Partial<RepoView> | null;
  if (!isRecord(view)) return null;
  return {
    branch: typeof view.branch === "string" ? view.branch : null,
    pull: typeof view.pull === "number" ? view.pull : null,
    file: typeof view.file === "string" ? view.file : null,
    folders: strings(view.folders, MAX_RESTORED_FOLDERS),
    commits: strings(view.commits, MAX_RESTORED_COMMITS),
    commitsPage: page(view.commitsPage),
    pullsPage: page(view.pullsPage),
    collapsedFiles: strings(view.collapsedFiles, MAX_RESTORED_FILES),
    openPullFiles: strings(view.openPullFiles, MAX_RESTORED_FILES),
    commitDrafts: draftTexts(view.commitDrafts),
    pullDrafts: draftTexts(view.pullDrafts),
  };
}

export function rememberRepoView(
  userId: number | undefined,
  fullName: string,
  view: RepoView
): void {
  if (userId === undefined) return;
  const session = readSession(userId) ?? emptySession(userId);
  writeSession({ ...session, views: { ...session.views, [fullName]: view } });
}

export function readDraft(
  userId: number | undefined,
  key: string
): CommentDraft | null {
  if (userId === undefined) return null;
  const drafts = readSession(userId)?.drafts;
  if (!drafts || !Object.hasOwn(drafts, key)) return null;
  const draft = drafts[key] as Partial<CommentDraft> | null;
  if (!isRecord(draft) || typeof draft.body !== "string") return null;
  const anchor = draft.anchor;
  const validAnchor =
    isRecord(anchor) &&
    (anchor.side === "LEFT" || anchor.side === "RIGHT") &&
    typeof anchor.line === "number" &&
    typeof anchor.position === "number";
  return validAnchor ? { body: draft.body, anchor } : { body: draft.body };
}

export function draftStore(
  userId: number | undefined,
  key: string
): DraftStore {
  const update = (draft: CommentDraft | null) => {
    if (userId === undefined) return;
    const session = readSession(userId) ?? emptySession(userId);
    const drafts = { ...session.drafts };
    if (draft) drafts[key] = draft;
    else delete drafts[key];
    writeSession({ ...session, drafts });
  };
  return {
    read: () => readDraft(userId, key),
    save: update,
    clear: () => update(null),
  };
}

export function readRepoScrolls(
  userId: number | undefined,
  fullName: string
): ScrollOffsets {
  if (userId === undefined) return {};
  const scrolls = readSession(userId)?.scrolls;
  if (!scrolls || !Object.hasOwn(scrolls, fullName)) return {};
  return Object.fromEntries(
    Object.entries(record<unknown>(scrolls[fullName])).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    )
  );
}

export function rememberRepoScrolls(
  userId: number | undefined,
  fullName: string,
  offsets: ScrollOffsets
): void {
  if (userId === undefined) return;
  const session = readSession(userId) ?? emptySession(userId);
  writeSession({
    ...session,
    scrolls: {
      ...session.scrolls,
      [fullName]: Object.fromEntries(
        Object.entries(offsets).slice(-MAX_SCROLL_PLACES)
      ),
    },
  });
}

export function forgetOpenRepo(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
