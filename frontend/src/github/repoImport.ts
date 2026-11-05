import { listImportableRepos } from "../api/github";
import { createProject, type Project } from "../api/workspace";

export function repoNameFromUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\.git$/, "");
  const match = cleaned.match(/([^/:]+)\/([^/]+)\/?$/);
  return match ? match[2] : cleaned;
}

// The owner/repo pairs already added, lowercased to compare with GitHub's or
// what's pasted.
export function linkedRepoNames(projects: Project[]): Set<string> {
  return new Set(
    projects
      .filter((p) => p.github_owner && p.github_repo)
      .map((p) => `${p.github_owner}/${p.github_repo}`.toLowerCase())
  );
}

// One project per visible repo, deduped by `owner/repo` against existing
// projects. Best-effort: a repo that fails to link is skipped rather than
// aborting the whole import.
export async function importAllRepos(
  existing: Project[],
  onProgress?: (done: number) => void
): Promise<Project[]> {
  const { connected, repos } = await listImportableRepos();
  if (!connected) {
    throw new Error("Connect your GitHub account to import your repositories.");
  }
  const alreadyLinked = linkedRepoNames(existing);
  const toAdd = repos.filter(
    (r) => !alreadyLinked.has(r.full_name.toLowerCase())
  );
  const created: Project[] = [];
  for (const repo of toAdd) {
    try {
      created.push(
        await createProject(repo.name, `https://github.com/${repo.full_name}`)
      );
    } catch {
      // Skip this repo; the rest of the import still proceeds.
    }
    onProgress?.(created.length);
  }
  return created;
}
