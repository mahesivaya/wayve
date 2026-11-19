import { useState } from "react";

// Whether the Files tab keeps the folder tree beside the folder or file being
// shown. Off by default, since the tree takes width from the code; remembered
// per browser like the other code-view choices.
const FILE_TREE_KEY = "rwayve.github.fileTree.v1";

export function useFileTreePref(): [boolean, (next: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(FILE_TREE_KEY) === "on";
    } catch {
      return false;
    }
  });
  const save = (next: boolean) => {
    setShown(next);
    try {
      localStorage.setItem(FILE_TREE_KEY, next ? "on" : "off");
    } catch {
      // Not persisted; the choice still holds for this visit.
    }
  };
  return [shown, save];
}
