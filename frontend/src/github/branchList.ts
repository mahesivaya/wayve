import { githubJson } from "./commitDiffData";

export type Branch = { name: string };

const PAGE_SIZE = 100;
// A bound on requests for a repo with thousands of branches. The default and
// current branch are always listed regardless (see orderBranches).
const MAX_PAGES = 10;

// GitHub lists branches alphabetically a page at a time, so stopping early hides
// whatever sorts late, which `main` usually does. Best-effort: an empty repo has
// none, and a page that fails still leaves those already fetched.
export async function fetchBranches(apiBase: string): Promise<Branch[]> {
  const all: Branch[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let rows: Branch[];
    try {
      rows = await githubJson<Branch[]>(
        `${apiBase}/branches?per_page=${PAGE_SIZE}&page=${page}`
      );
    } catch {
      break;
    }
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// The default branch first, then the rest in GitHub's order, with the current
// branch listed even if it wasn't fetched.
export function orderBranches(
  branches: Branch[],
  defaultBranch: string | undefined,
  current: string
): string[] {
  const names = branches.map((branch) => branch.name);
  const pinned = [defaultBranch, names.includes(current) ? "" : current];
  return [...new Set([...pinned, ...names])].filter((name): name is string =>
    Boolean(name)
  );
}
