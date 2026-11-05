// The repo sections: all listed in the wide rail; on a narrow page, one row with
// the rest under "More".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SectionNav } from "../../github/SectionNav";
import { fittingTabs, splitTabs } from "../../github/sectionTabs";

const ITEMS = [
  { id: "description", label: "Description", icon: "d" },
  { id: "files", label: "Files", icon: "f" },
  { id: "commits", label: "Commits", icon: "c", count: 20 },
  { id: "pulls", label: "Pull Requests", icon: "p", count: 3 },
  { id: "actions", label: "Actions", icon: "a", count: null },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fittingTabs", () => {
  it("fits everything without reserving room for More", () => {
    expect(fittingTabs([100, 100], 60, 208, 8)).toBe(2);
  });
  it("leaves room for More when something has to move", () => {
    expect(fittingTabs([100, 100, 100], 60, 300, 8)).toBe(2);
    expect(fittingTabs([100, 100, 100], 60, 200, 8)).toBe(1);
  });
  it("can fit nothing but More", () => {
    expect(fittingTabs([100], 60, 90, 8)).toBe(0);
  });
});

describe("splitTabs", () => {
  const ids = (list: { id: string }[]) => list.map((item) => item.id);

  it("keeps order when the open section is showing", () => {
    const { shown, more } = splitTabs(ITEMS, 3, "files");
    expect(ids(shown)).toEqual(["description", "files", "commits"]);
    expect(ids(more)).toEqual(["pulls", "actions"]);
  });
  it("brings the open section into the row", () => {
    const { shown, more } = splitTabs(ITEMS, 3, "actions");
    expect(ids(shown)).toEqual(["description", "files", "actions"]);
    expect(ids(more)).toEqual(["commits", "pulls"]);
  });
  it("has nothing under More when all fit", () => {
    expect(splitTabs(ITEMS, 5, "files").more).toEqual([]);
  });
});

describe("SectionNav", () => {
  const renderNav = (active = "description") => {
    const onSelect = vi.fn();
    render(<SectionNav items={ITEMS} active={active} onSelect={onSelect} />);
    return onSelect;
  };

  // jsdom has no layout: pretend the stylesheet chose the row, give sizes, and
  // have the observer report as a browser's does when it starts.
  const asRow = (available: number) => {
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) =>
      (el as Element).matches(".github-section-nav")
        ? ({
            flexDirection: "row",
            paddingLeft: "0",
            paddingRight: "0",
            columnGap: "0",
          } as CSSStyleDeclaration)
        : real(el)
    );
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(
      available
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      }
    );
  };

  it("lists every section in the rail, marking the open one", () => {
    renderNav("files");
    const nav = screen.getByRole("navigation", { name: "Repository sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Files" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("button", { name: /Commits/ }).textContent
    ).toContain("20");
  });

  it("selects a section", async () => {
    const onSelect = renderNav();
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onSelect).toHaveBeenCalledWith("files");
  });

  it("moves what doesn't fit under More, and picks from there", async () => {
    asRow(320);
    const onSelect = renderNav();

    expect(screen.getByRole("button", { name: "Description" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pull Requests/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /More/ }));
    const menu = screen.getByRole("menu", { name: "More" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: /Pull Requests/ })
    );

    expect(onSelect).toHaveBeenCalledWith("pulls");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the open section on the row, even when barely anything fits", () => {
    asRow(150);
    renderNav("actions");
    expect(
      screen
        .getByRole("button", { name: "Actions" })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(screen.queryByRole("button", { name: "Description" })).toBeNull();
  });

  it("closes the menu on Escape", async () => {
    asRow(320);
    renderNav();
    await userEvent.click(screen.getByRole("button", { name: /More/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
