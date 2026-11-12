// PR body on the in-app PR page: Summary always shown; Changes, Testing and
// other sections folded behind a toggle; no "Description" header.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PrDescription from "../../github/PrDescription";
import { splitDescription } from "../../github/prSections";

const BODY = [
  "## Summary",
  "",
  "Adds a merge dropdown.",
  "",
  "## Changes",
  "",
  "- New PrMergeButton",
  "",
  "## Testing",
  "",
  "```sh",
  "# not a heading",
  "npm test",
  "```",
].join("\n");

const renderText = (t: string) => <span>{t}</span>;

describe("splitDescription", () => {
  it("splits on headings, ignoring # inside code blocks", () => {
    const { intro, sections } = splitDescription(BODY);
    expect(intro).toBe("");
    expect(sections.map((s) => s.title)).toEqual([
      "Summary",
      "Changes",
      "Testing",
    ]);
    expect(sections[2].body).toContain("# not a heading");
  });
});

describe("PrDescription", () => {
  it("always shows Summary and folds the other sections", () => {
    render(<PrDescription body={BODY} renderText={renderText} />);

    expect(screen.queryByText("Description")).toBeNull();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(screen.getByText("Adds a merge dropdown.")).toBeTruthy();

    const changes = screen.getByRole("button", { name: "Changes" });
    expect(changes.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("- New PrMergeButton")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Testing" })
        .getAttribute("aria-expanded")
    ).toBe("false");

    fireEvent.click(changes);
    expect(changes.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("- New PrMergeButton")).toBeTruthy();

    fireEvent.click(changes);
    expect(screen.queryByText("- New PrMergeButton")).toBeNull();
  });

  it("shows a body without headings as-is", () => {
    render(<PrDescription body="Just a note." renderText={renderText} />);
    expect(screen.getByText("Just a note.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
