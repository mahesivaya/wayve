// The files a merge request changes, arranged by folder for the tree beside
// the diffs. A run of folders that each hold only the next one is shown as a
// single row ("frontend/src"), so the tree is no deeper than it has to be.

export type ChangedFile = {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
};

export type ChangedNode<T extends ChangedFile = ChangedFile> =
  | { kind: "dir"; name: string; path: string; children: ChangedNode<T>[] }
  | { kind: "file"; name: string; path: string; file: T };

type Dir<T extends ChangedFile> = Extract<ChangedNode<T>, { kind: "dir" }>;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// Folders first, then files, each by name; single-folder chains joined.
function tidy<T extends ChangedFile>(
  nodes: ChangedNode<T>[]
): ChangedNode<T>[] {
  const dirs = nodes
    .filter((n): n is Dir<T> => n.kind === "dir")
    .map((dir) => {
      let merged = { ...dir, children: tidy(dir.children) };
      while (
        merged.children.length === 1 &&
        merged.children[0].kind === "dir"
      ) {
        const only = merged.children[0];
        merged = {
          kind: "dir",
          name: `${merged.name}/${only.name}`,
          path: only.path,
          children: only.children,
        };
      }
      return merged;
    });
  const files = nodes.filter((n) => n.kind === "file");
  return [...dirs.sort(byName), ...files.sort(byName)];
}

export function buildChangedTree<T extends ChangedFile>(
  files: T[]
): ChangedNode<T>[] {
  const root: ChangedNode<T>[] = [];
  for (const file of files) {
    const parts = file.filename.split("/").filter(Boolean);
    const name = parts.pop() ?? file.filename;
    let level = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let dir = level.find(
        (n): n is Dir<T> => n.kind === "dir" && n.name === part
      );
      if (!dir) {
        dir = { kind: "dir", name: part, path, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({ kind: "file", name, path: file.filename, file });
  }
  return tidy(root);
}
