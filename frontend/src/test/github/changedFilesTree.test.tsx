// A merge request's changed files as a tree: grouped by folder, with runs of
// single folders joined, and each file one click from its diff.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangedFilesTree } from "../../github/ChangedFilesTree";
import { buildChangedTree } from "../../github/changedTree";

const file = (filename: string, additions = 1, deletions = 0) => ({
  filename,
  additions,
  deletions,
  status: "modified",
});

const FILES = [
  file("frontend/src/tasks/tasks.css", 33, 32),
  file("frontend/src/aifix/aiFix.css", 5, 7),
  file("frontend/src/test/settings/entry.test.tsx", 3, 1),
  file("README.md", 2, 0),
];

describe("buildChangedTree", () => {
  it("groups files by folder, joining folders that hold only one folder", () => {
    const tree = buildChangedTree(FILES);
    expect(tree.map((n) => [n.kind, n.name])).toEqual([
      ["dir", "frontend/src"],
      ["file", "README.md"],
    ]);
    const src = tree[0];
    if (src.kind !== "dir") throw new Error("expected a folder");
    // Folders by name; a chain below is joined too.
    expect(src.children.map((n) => n.name)).toEqual([
      "aifix",
      "tasks",
      "test/settings",
    ]);
    expect(src.path).toBe("frontend/src");
  });

  it("keeps a folder that holds a file as well as a folder", () => {
    const tree = buildChangedTree([file("a/b/c.ts"), file("a/d.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["a"]);
    const a = tree[0];
    if (a.kind !== "dir") throw new Error("expected a folder");
    expect(a.children.map((n) => [n.kind, n.name])).toEqual([
      ["dir", "b"],
      ["file", "d.ts"],
    ]);
  });

  it("handles no files", () => {
    expect(buildChangedTree([])).toEqual([]);
  });
});

describe("ChangedFilesTree", () => {
  afterEach(() => cleanup());

  it("lists every file with its line counts and reports the one chosen", () => {
    const onSelect = vi.fn();
    render(<ChangedFilesTree files={FILES} onSelect={onSelect} />);
    const tree = screen.getByRole("tree", { name: "Changed files" });
    expect(tree).toBeTruthy();

    const row = screen.getByRole("button", { name: /tasks\.css/ });
    expect(row.textContent).toContain("+33");
    expect(row.textContent).toContain("−32");
    // Nothing removed: no zero is shown.
    expect(
      screen.getByRole("button", { name: /README\.md/ }).textContent
    ).not.toContain("−");

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(FILES[0]);
  });

  it("closes and reopens a folder", () => {
    render(<ChangedFilesTree files={FILES} onSelect={vi.fn()} />);
    const folder = screen.getByRole("button", { name: "frontend/src" });
    fireEvent.click(folder);
    expect(screen.queryByRole("button", { name: /tasks\.css/ })).toBeNull();
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeTruthy();
    fireEvent.click(folder);
    expect(screen.getByRole("button", { name: /tasks\.css/ })).toBeTruthy();
  });
});
