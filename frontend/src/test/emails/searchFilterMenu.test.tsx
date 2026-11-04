// The filter icon in the emails search box chooses where a search looks: all
// mail, or one of the folders that all mail leaves out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchFilterMenu } from "../../emails/SearchFilterMenu";
import type { EmailFolder } from "../../emails/types";

const renderMenu = (activeFolder: EmailFolder) => {
  const onSelectFolder = vi.fn();
  render(
    <>
      <SearchFilterMenu
        activeFolder={activeFolder}
        onSelectFolder={onSelectFolder}
      />
      <button>elsewhere</button>
    </>
  );
  return onSelectFolder;
};

const openMenu = () =>
  userEvent.click(screen.getByRole("button", { name: "Search options" }));
const scope = (name: string) => screen.getByRole("menuitemradio", { name });

afterEach(cleanup);

describe("the search options menu", () => {
  it("stays closed until the icon is clicked", async () => {
    renderMenu("inbox");
    expect(screen.queryByRole("menu")).toBeNull();

    await openMenu();

    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("marks all mail for a folder that searches all mail", async () => {
    renderMenu("inbox");
    await openMenu();

    expect(scope("All mail").getAttribute("aria-checked")).toBe("true");
    expect(scope("Trash").getAttribute("aria-checked")).toBe("false");
  });

  it("marks the folder that is searched in place", async () => {
    renderMenu("trash");
    await openMenu();

    expect(scope("Trash").getAttribute("aria-checked")).toBe("true");
    expect(scope("All mail").getAttribute("aria-checked")).toBe("false");
  });

  it("moves to a chosen folder and closes", async () => {
    const onSelectFolder = renderMenu("inbox");
    await openMenu();

    await userEvent.click(scope("Spam"));

    expect(onSelectFolder).toHaveBeenCalledWith("spam");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays in the folder when its current scope is chosen", async () => {
    const onSelectFolder = renderMenu("inbox");
    await openMenu();

    await userEvent.click(scope("All mail"));

    expect(onSelectFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and on a click outside", async () => {
    renderMenu("inbox");
    await openMenu();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await openMenu();
    await userEvent.click(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
