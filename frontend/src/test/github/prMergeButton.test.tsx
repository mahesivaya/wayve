// PR header merge control: Squash / Rebase menu with a confirm step, or a
// Conflicts pill when the branch can't merge.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PrMergeButton from "../../github/PrMergeButton";

const base = { number: 232, baseRef: "main", merging: false };

describe("PrMergeButton", () => {
  it("offers only Squash and Rebase, and merges after confirming", () => {
    const onMerge = vi.fn();
    render(<PrMergeButton {...base} mergeable onMerge={onMerge} />);

    fireEvent.click(screen.getByRole("button", { name: /Squash & merge/ }));
    const options = screen.getAllByRole("menuitemradio");
    expect(
      options.map((o) => o.querySelector(".pr-merge-option-label")?.textContent)
    ).toEqual(["Squash and merge", "Rebase and merge"]);

    fireEvent.click(options[1]);
    expect(screen.getByText(/Rebase and merge #232 into/)).toBeTruthy();
    expect(onMerge).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm rebase and merge" })
    );
    expect(onMerge).toHaveBeenCalledWith("rebase");
    // The pill now names the chosen method.
    expect(screen.getByRole("button", { name: /Rebase & merge/ })).toBeTruthy();
  });

  it("shows Conflicts instead of a merge button when the branch conflicts", () => {
    render(<PrMergeButton {...base} mergeable={false} onMerge={vi.fn()} />);
    expect(screen.getByText("Conflicts")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("waits while GitHub is still checking mergeability", () => {
    render(<PrMergeButton {...base} mergeable={null} onMerge={vi.fn()} />);
    const pill = screen.getByRole("button", { name: /Checking/ });
    expect(pill).toHaveProperty("disabled", true);
  });
});
