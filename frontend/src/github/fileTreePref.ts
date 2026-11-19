import { useState } from "react";

// An on/off choice remembered per browser, like the other code-view choices.
function useStoredSwitch(key: string): [boolean, (next: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(key) === "on";
    } catch {
      return false;
    }
  });
  const save = (next: boolean) => {
    setShown(next);
    try {
      localStorage.setItem(key, next ? "on" : "off");
    } catch {
      // Not persisted; the choice still holds for this visit.
    }
  };
  return [shown, save];
}

// Whether the Files tab keeps the folder tree beside the folder or file being
// shown. Off by default, since the tree takes width from the code.
export const useFileTreePref = () =>
  useStoredSwitch("rwayve.github.fileTree.v1");

// Whether a merge request's Changes tab shows its changed files as a tree
// beside the diffs. Off by default for the same reason.
export const useChangesTreePref = () =>
  useStoredSwitch("rwayve.github.changesTree.v1");
