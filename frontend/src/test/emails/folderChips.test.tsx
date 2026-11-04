// The folder menu on org and platform pages, which have no email sidebar.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderChips } from "../../emails/FolderChips";

const labels = () =>
  screen.getAllByRole("button").map((button) => button.textContent);

const openMore = (name: RegExp = /More/) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("FolderChips", () => {
  afterEach(cleanup);

  it("lists the folders in order, with the dropdown last", () => {
    render(<FolderChips activeFolder="inbox" onSelectFolder={vi.fn()} />);
    expect(labels()).toEqual([
      "Inbox",
      "Sent",
      "Draft",
      "Scheduled",
      "Starred",
      "Trash",
      "More ▾",
    ]);
  });

  it("opens the folder behind each tab", () => {
    const onSelectFolder = vi.fn();
    render(
      <FolderChips activeFolder="inbox" onSelectFolder={onSelectFolder} />
    );
    for (const name of [
      "Inbox",
      "Sent",
      "Draft",
      "Scheduled",
      "Starred",
      "Trash",
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(onSelectFolder.mock.calls.map(([folder]) => folder)).toEqual([
      "inbox",
      "sent",
      "drafts",
      "scheduled",
      "starred",
      "trash",
    ]);
  });

  it("highlights only the active folder", () => {
    render(<FolderChips activeFolder="drafts" onSelectFolder={vi.fn()} />);
    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed.map((button) => button.textContent)).toEqual(["Draft"]);
  });

  it("offers Spam, Promotions and Archived from the dropdown, then closes", () => {
    const onSelectFolder = vi.fn();
    render(
      <FolderChips activeFolder="inbox" onSelectFolder={onSelectFolder} />
    );
    expect(screen.queryByRole("menu")).toBeNull();

    for (const [name, folder] of [
      ["Spam", "spam"],
      ["Promotions", "promotions"],
      ["Archived", "archived"],
    ]) {
      openMore();
      fireEvent.click(screen.getByRole("menuitem", { name }));
      expect(onSelectFolder).toHaveBeenLastCalledWith(folder);
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("names and highlights the dropdown while one of its folders is open", () => {
    render(<FolderChips activeFolder="archived" onSelectFolder={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /Archived/ });
    expect(trigger.className).toContain("is-active");
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
  });

  it("closes on Escape and on a click outside", () => {
    render(<FolderChips activeFolder="inbox" onSelectFolder={vi.fn()} />);
    openMore();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    openMore();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
