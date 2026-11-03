// Code Repo diffs: revealing the unchanged lines a patch leaves out.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommitPatch } from "../../github/commitDiff";
import { DEFAULT_DIFF_PREFS } from "../../github/diffPrefs";
import { canExpandFile, decodeFileLines } from "../../github/commitDiffData";

// A 100-line file with line 50 changed, and 3 lines of context either side.
const FILE = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
const PATCH = [
  "@@ -47,7 +47,7 @@ function outer() {",
  " line 47",
  " line 48",
  " line 49",
  "-old 50",
  "+line 50",
  " line 51",
  " line 52",
  " line 53",
].join("\n");

const newSideNumbers = (root: Element) =>
  Array.from(root.querySelectorAll(".github-split-no"))
    .filter((_, i) => i % 2 === 1)
    .map((el) => Number(el.textContent));

const oldSideNumbers = (root: Element) =>
  Array.from(root.querySelectorAll(".github-split-no"))
    .filter((_, i) => i % 2 === 0)
    .map((el) => el.textContent);

describe("expanding unchanged lines", () => {
  it("keeps a plain hunk header when nothing can load the file", () => {
    const { container } = render(<CommitPatch patch={PATCH} />);
    expect(container.querySelector(".github-diff-gap")).toBeNull();
    expect(screen.getByText(/@@ -47,7/)).toBeTruthy();
  });

  it("counts the lines above the first hunk instead of showing its header", () => {
    render(<CommitPatch patch={PATCH} loadLines={async () => FILE} />);
    expect(screen.getByText("46 unchanged lines")).toBeTruthy();
    expect(screen.queryByText(/function outer/)).toBeNull();
    // Nothing sits above the first gap, so it only reveals upward; the end of
    // the file only reveals downward.
    expect(screen.getAllByRole("button", { name: /lines above/ })).toHaveLength(
      1
    );
    expect(screen.getAllByRole("button", { name: /lines below/ })).toHaveLength(
      1
    );
  });

  it("reveals 20 lines at a time from the edge next to the hunk", async () => {
    const { container } = render(
      <CommitPatch patch={PATCH} loadLines={async () => FILE} />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show 20 lines above" })[0]
    );
    await screen.findByText("26 unchanged lines");
    const numbers = newSideNumbers(container);
    expect(numbers.slice(0, 2)).toEqual([27, 28]);
    expect(numbers[19]).toBe(46);
    expect(numbers[20]).toBe(47);
  });

  it("fetches the file once across every reveal", async () => {
    const loadLines = vi.fn(async () => FILE);
    render(<CommitPatch patch={PATCH} loadLines={loadLines} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show 20 lines above" })[0]
    );
    await screen.findByText("26 unchanged lines");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show 20 lines above" })[0]
    );
    await screen.findByText("6 unchanged lines");
    expect(loadLines).toHaveBeenCalledTimes(1);
  });

  it("drops the gap and its header once every line above is showing", async () => {
    const { container } = render(
      <CommitPatch patch={PATCH} loadLines={async () => FILE} />
    );
    fireEvent.click(screen.getByText("46 unchanged lines"));
    await waitFor(() =>
      expect(newSideNumbers(container).slice(0, 2)).toEqual([1, 2])
    );
    expect(screen.queryByText(/@@ -47,7/)).toBeNull();
  });

  it("counts the end of the file once it has loaded", async () => {
    const { container } = render(
      <CommitPatch patch={PATCH} loadLines={async () => FILE} />
    );
    fireEvent.click(screen.getByText("Show the rest of the file"));
    await waitFor(() => {
      const numbers = newSideNumbers(container);
      expect(numbers[numbers.length - 1]).toBe(100);
    });
    expect(screen.queryByText("Show the rest of the file")).toBeNull();
  });

  it("offers nothing below a hunk that already reached the end of the file", () => {
    const patch = [
      "@@ -97,4 +97,4 @@",
      " line 97",
      "-old",
      "+line 98",
      " line 99",
    ].join("\n");
    render(<CommitPatch patch={patch} loadLines={async () => FILE} />);
    expect(screen.queryByText("Show the rest of the file")).toBeNull();
  });

  it("keeps old line numbers aligned after a hunk that changes the line count", async () => {
    const patch = [
      "@@ -10,3 +10,4 @@",
      " line 10",
      "+line 11",
      " line 12",
      " line 13",
      "@@ -40,3 +41,3 @@",
      " line 41",
      " line 42",
      " line 43",
    ].join("\n");
    const { container } = render(
      <CommitPatch patch={patch} loadLines={async () => FILE} />
    );
    fireEvent.click(screen.getByText("27 unchanged lines"));
    await waitFor(() =>
      expect(screen.queryByText("27 unchanged lines")).toBeNull()
    );
    // New line 14, the first one revealed, was line 13 before the insertion.
    const revealed = newSideNumbers(container).indexOf(14);
    expect(oldSideNumbers(container)[revealed]).toBe("13");
  });

  it("unified layout shows one line number per row", () => {
    const { container } = render(
      <CommitPatch
        patch={PATCH}
        prefs={{ ...DEFAULT_DIFF_PREFS, layout: "unified" }}
      />
    );
    const numbers = Array.from(
      container.querySelectorAll(".github-split-no")
    ).map((el) => el.textContent);
    // Numbered by the new file; the removal has no line there.
    expect(numbers).toEqual(["47", "48", "49", "−", "50", "51", "52", "53"]);
  });

  it("shows the failure on the row and retries on the next click", async () => {
    const loadLines = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("This file is too large to expand."))
      .mockResolvedValueOnce(FILE);
    render(<CommitPatch patch={PATCH} loadLines={loadLines} />);
    fireEvent.click(screen.getByText("46 unchanged lines"));
    expect((await screen.findAllByRole("alert"))[0].textContent).toContain(
      "too large"
    );
    fireEvent.click(screen.getByText("46 unchanged lines"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() =>
      expect(screen.queryByText("46 unchanged lines")).toBeNull()
    );
  });
});

describe("file lines", () => {
  it("decodes multi-byte text from GitHub's wrapped base64", () => {
    const bytes = new TextEncoder().encode("héllo\nwörld\n");
    const base64 = btoa(String.fromCharCode(...bytes));
    const wrapped = `${base64.slice(0, 6)}\n${base64.slice(6)}\n`;
    expect(decodeFileLines({ content: wrapped, encoding: "base64" })).toEqual([
      "héllo",
      "wörld",
    ]);
  });

  it("rejects the empty body GitHub sends for files over 1 MB", () => {
    expect(() => decodeFileLines({ content: "", encoding: "none" })).toThrow(
      "too large"
    );
  });

  it("only expands files that exist on both sides", () => {
    expect(canExpandFile("modified")).toBe(true);
    expect(canExpandFile("renamed")).toBe(true);
    expect(canExpandFile("added")).toBe(false);
    expect(canExpandFile("removed")).toBe(false);
  });
});
