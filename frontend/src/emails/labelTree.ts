// The sidebar's Labels tree, built from Gmail label names ("/" nests them).
import type { SidebarLabel } from "../api/email";
import type { EmailFolder } from "./types";

export const labelFolder = (l: { account_id: number; label_id: string }) =>
  `label:${l.account_id}:${l.label_id}` as EmailFolder;

// A label path segment. `label` is set when that exact path is a real label
// (Gmail usually creates the parents too, but not always).
export type LabelNode = {
  key: string;
  segment: string;
  label: SidebarLabel | null;
  children: LabelNode[];
};

// Nest one account's labels by the "/" in their names, sorted per level.
export function buildLabelTree(labels: SidebarLabel[]): LabelNode[] {
  const root: LabelNode = { key: "", segment: "", label: null, children: [] };
  for (const label of labels) {
    let node = root;
    const parts = label.name.split("/").filter(Boolean);
    parts.forEach((segment, i) => {
      const key = `${label.account_id}:${parts.slice(0, i + 1).join("/")}`;
      let child = node.children.find((c) => c.key === key);
      if (!child) {
        child = { key, segment, label: null, children: [] };
        node.children.push(child);
      }
      if (i === parts.length - 1) child.label = label;
      node = child;
    });
  }
  const sort = (nodes: LabelNode[]) => {
    nodes.sort((a, b) =>
      a.segment.localeCompare(b.segment, undefined, { sensitivity: "base" })
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}
