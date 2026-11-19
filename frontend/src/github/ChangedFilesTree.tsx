import { useMemo, useState } from "react";
import { ChevronIcon } from "../icons";
import { FileTypeIcon, FolderIcon } from "./FileTypeIcon";
import {
  buildChangedTree,
  type ChangedFile,
  type ChangedNode,
} from "./changedTree";

/**
 * Where a merge request's changed files sit in the repository: a tree of their
 * folders beside the diffs, each file with its added and removed line counts.
 * Choosing a file goes to its diff. Folders start open and can be closed.
 */
export function ChangedFilesTree<T extends ChangedFile>({
  files,
  onSelect,
}: {
  files: T[];
  onSelect: (file: T) => void;
}) {
  const tree = useMemo(() => buildChangedTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const renderNodes = (nodes: ChangedNode<T>[], depth: number) =>
    nodes.map((node) => {
      const pad = { paddingLeft: 8 + depth * 14 };
      if (node.kind === "file") {
        return (
          <li key={node.path} role="treeitem" aria-selected={false}>
            <button
              type="button"
              className={`github-tree-row status-${node.file.status}`}
              style={pad}
              title={node.path}
              onClick={() => onSelect(node.file)}
            >
              <span className="github-tree-toggle" aria-hidden="true" />
              <span className="github-file-kind" aria-hidden="true">
                <FileTypeIcon path={node.path} />
              </span>
              <span className="github-tree-name">{node.name}</span>
              <span className="github-tree-stats">
                {node.file.additions > 0 && (
                  <span className="github-commit-stat is-add">
                    +{node.file.additions}
                  </span>
                )}
                {node.file.deletions > 0 && (
                  <span className="github-commit-stat is-del">
                    −{node.file.deletions}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      }
      const isOpen = !closed.has(node.path);
      return (
        <li
          key={node.path}
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={false}
        >
          <button
            type="button"
            className="github-tree-row"
            style={pad}
            title={node.path}
            onClick={() => toggle(node.path)}
          >
            <span
              className={`github-tree-toggle${isOpen ? " open" : ""}`}
              aria-hidden="true"
            >
              <ChevronIcon size={14} />
            </span>
            <span className="github-file-kind" aria-hidden="true">
              <FolderIcon />
            </span>
            <span className="github-tree-name">{node.name}</span>
          </button>
          {isOpen && (
            <ul role="group">{renderNodes(node.children, depth + 1)}</ul>
          )}
        </li>
      );
    });

  return (
    <ul className="github-tree" role="tree" aria-label="Changed files">
      {renderNodes(tree, 0)}
    </ul>
  );
}
