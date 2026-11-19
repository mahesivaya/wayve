import { useEffect, useRef, useState } from "react";
import { ChevronIcon } from "../icons";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon";

export type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
};

// "a/b/c" → ["a", "a/b"]: the folders that must be open for the path to show.
const foldersAbove = (path: string) => {
  const parts = path.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

type Props<T extends TreeEntry> = {
  // Folder path → its entries, as far as they have been loaded ("" is the root).
  items: Record<string, T[] | undefined>;
  loading: Set<string>;
  // The branch the entries belong to; a change means every folder loads anew.
  branch: string;
  // The open file, or the folder the main pane lists.
  activePath: string;
  activeIsFile: boolean;
  sort: (entries: T[]) => T[];
  onLoad: (path: string) => void;
  onOpenFile: (entry: T) => void;
};

/**
 * The repository's folders as a tree that stays put while files are opened.
 * A folder opens and closes in place, loading its entries the first time; a
 * file opens in the main pane. The folders leading to whatever the main pane
 * shows are opened so it is always in view.
 */
export function RepoFileTree<T extends TreeEntry>({
  items,
  loading,
  branch,
  activePath,
  activeIsFile,
  sort,
  onLoad,
  onOpenFile,
}: Props<T>) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Open the folders leading to the main pane's file or folder, once each time
  // it changes (during render, so there is no extra pass through an effect).
  // Folders opened earlier stay open.
  const activeKey = `${activeIsFile ? "f" : "d"}:${activePath}`;
  const [revealedKey, setRevealedKey] = useState("");
  if (activeKey !== revealedKey) {
    setRevealedKey(activeKey);
    const reveal = activeIsFile
      ? foldersAbove(activePath)
      : [...foldersAbove(activePath), activePath].filter(Boolean);
    if (reveal.some((path) => !open.has(path))) {
      setOpen(new Set([...open, ...reveal]));
    }
  }

  // Load the root and every open folder that has no entries yet: on first
  // show, and again after a branch switch empties them. Asked once per branch,
  // so a folder that fails to load isn't requested in a loop.
  const asked = useRef({ branch, paths: new Set<string>() });
  useEffect(() => {
    if (asked.current.branch !== branch) {
      asked.current = { branch, paths: new Set() };
    }
    for (const path of ["", ...open]) {
      if (items[path] || loading.has(path) || asked.current.paths.has(path)) {
        continue;
      }
      asked.current.paths.add(path);
      onLoad(path);
    }
  }, [branch, items, loading, onLoad, open]);

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderFolder = (path: string, depth: number) => {
    const entries = items[path];
    if (!entries) {
      return (
        <li
          className="github-tree-note"
          style={{ paddingLeft: 8 + depth * 14 }}
          role="none"
        >
          {loading.has(path) ? "Loading..." : "Couldn't load this folder."}
        </li>
      );
    }
    if (entries.length === 0) {
      return (
        <li
          className="github-tree-note"
          style={{ paddingLeft: 8 + depth * 14 }}
          role="none"
        >
          Empty
        </li>
      );
    }
    return sort(entries).map((entry) => {
      const isDir = entry.type === "dir";
      const isOpen = isDir && open.has(entry.path);
      const isActive = entry.path === activePath;
      return (
        <li
          key={entry.path}
          role="treeitem"
          aria-expanded={isDir ? isOpen : undefined}
          aria-selected={isActive}
        >
          <button
            type="button"
            className={`github-tree-row${isActive ? " is-active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={entry.path}
            onClick={() => (isDir ? toggle(entry.path) : onOpenFile(entry))}
          >
            <span
              className={`github-tree-toggle${isOpen ? " open" : ""}`}
              aria-hidden="true"
            >
              {isDir && <ChevronIcon size={14} />}
            </span>
            <span className="github-file-kind" aria-hidden="true">
              {isDir ? <FolderIcon /> : <FileTypeIcon path={entry.path} />}
            </span>
            <span className="github-tree-name">{entry.name}</span>
          </button>
          {isOpen && (
            <ul role="group">{renderFolder(entry.path, depth + 1)}</ul>
          )}
        </li>
      );
    });
  };

  return (
    <ul className="github-tree" role="tree" aria-label="File tree">
      {renderFolder("", 0)}
    </ul>
  );
}
