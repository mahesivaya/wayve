// Code Repo › Commits diff settings: the gear menu's Layout (Unified / Split),
// Hide whitespace and Compact line height, and how CommitPatch draws each.
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommitPatch, DiffSettingsMenu } from "../../github/commitDiff";
import { DEFAULT_DIFF_PREFS, useDiffPrefs } from "../../github/diffPrefs";

const PATCH = [
  "@@ -1,3 +1,3 @@",
  " keep",
  "-  indented",
  "+    indented",
  "-old",
  "+new",
].join("\n");

function Harness() {
  const [prefs, setPrefs] = useDiffPrefs();
  return (
    <>
      <DiffSettingsMenu prefs={prefs} onChange={setPrefs} />
      <CommitPatch patch={PATCH} prefs={prefs} />
    </>
  );
}

const cellTexts = (root: Element, kind: string) =>
  Array.from(root.querySelectorAll(`.github-split-code.is-${kind}`)).map(
    (el) => el.textContent
  );

describe("diff settings", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to split with both changed lines as removals and additions", () => {
    const { container } = render(<CommitPatch patch={PATCH} />);
    expect(container.querySelector(".github-split")).not.toBeNull();
    expect(cellTexts(container, "del")).toEqual(["  indented", "old"]);
    expect(cellTexts(container, "add")).toEqual(["    indented", "new"]);
  });

  it("hide whitespace turns a whitespace-only change into context", () => {
    const { container } = render(
      <CommitPatch
        patch={PATCH}
        prefs={{ ...DEFAULT_DIFF_PREFS, hideWhitespace: true }}
      />
    );
    expect(cellTexts(container, "del")).toEqual(["old"]);
    expect(cellTexts(container, "add")).toEqual(["new"]);
  });

  it("unified layout lists removals then additions in one column", () => {
    const { container } = render(
      <CommitPatch
        patch={PATCH}
        prefs={{ ...DEFAULT_DIFF_PREFS, layout: "unified" }}
      />
    );
    const root = container.querySelector(".github-unified");
    expect(root).not.toBeNull();
    const codes = Array.from(root!.querySelectorAll(".github-split-code")).map(
      (el) => el.textContent
    );
    expect(codes).toEqual([
      "  keep",
      "-   indented",
      "- old",
      "+     indented",
      "+ new",
    ]);
  });

  it("the gear menu switches layout and toggles, and remembers them", () => {
    const { container, unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Diff settings" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Split/ })
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Unified/ }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Compact line height/ })
    );
    expect(
      container.querySelector(".github-unified.is-compact")
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Hide whitespace/ })
    ).toHaveAttribute("aria-checked", "false");

    unmount();
    const again = render(<Harness />);
    expect(
      again.container.querySelector(".github-unified.is-compact")
    ).not.toBeNull();
  });

  it("Escape closes the menu", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Diff settings" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
