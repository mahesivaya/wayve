// Where you were in Code Repo outlives the page: every route change unmounts it,
// so without this coming back from Chat lands on the first repo's default branch.
// Names, numbers and paths only, never file contents, and not a file's
// `download_url`, which carries a token for a private repo. sessionStorage outlives
// a logout within the tab, so the entry names its owner and AuthContext clears it
// on logout and session expiry.
const STORAGE_KEY = "rwayve.github.open";

// Each comes back with a request, so a long session can't turn returning into a
// burst of them. The most recently opened are kept.
const MAX_RESTORED_FOLDERS = 30;
const MAX_RESTORED_COMMITS = 10;

export type RepoView = {
  branch: string | null;
  pull: number | null;
  file: string | null;
  folders: string[];
  commits: string[];
};

type OpenRepoSession = {
  userId: number;
  // A project id, or `owner/repo` on the platform page, which has no projects.
  repo: number | string | null;
  views: Record<string, RepoView>;
};

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(-max)
    : [];

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
      views:
        parsed.views && typeof parsed.views === "object" ? parsed.views : {},
    };
  } catch {
    return null;
  }
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
  writeSession({ userId, views: {}, ...readSession(userId), repo });
}

export function readRepoView(
  userId: number | undefined,
  fullName: string
): RepoView | null {
  if (userId === undefined) return null;
  const views = readSession(userId)?.views;
  if (!views || !Object.hasOwn(views, fullName)) return null;
  const view = views[fullName] as Partial<RepoView> | null;
  if (!view || typeof view !== "object") return null;
  return {
    branch: typeof view.branch === "string" ? view.branch : null,
    pull: typeof view.pull === "number" ? view.pull : null,
    file: typeof view.file === "string" ? view.file : null,
    folders: strings(view.folders, MAX_RESTORED_FOLDERS),
    commits: strings(view.commits, MAX_RESTORED_COMMITS),
  };
}

export function rememberRepoView(
  userId: number | undefined,
  fullName: string,
  view: RepoView
): void {
  if (userId === undefined) return;
  const session = readSession(userId) ?? { userId, repo: null, views: {} };
  writeSession({ ...session, views: { ...session.views, [fullName]: view } });
}

export function forgetOpenRepo(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — private mode / quota
  }
}
