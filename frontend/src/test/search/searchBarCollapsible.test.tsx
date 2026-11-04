// The Emails toolbar shows a search icon that opens into the search box. Other
// pages keep the plain box. Only the search context is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ initialQuery: "" }));

vi.mock("../../search/SearchContext", () => ({
  useGlobalSearch: () => {
    const [searchQuery, setSearchQuery] = useState(h.initialQuery);
    return {
      searchQuery,
      setSearchQuery,
      emailViewLayout: "list",
      setEmailViewLayout: vi.fn(),
    };
  },
}));

import SearchBar from "../../search/SearchBar";

const renderBar = (collapsible = true) =>
  render(
    <MemoryRouter initialEntries={["/emails"]}>
      <SearchBar collapsible={collapsible} />
      <button>elsewhere</button>
    </MemoryRouter>
  );

const input = () => screen.queryByRole("searchbox");
const icon = () => screen.getByRole("button", { name: "Search all emails" });

beforeEach(() => {
  h.initialQuery = "";
});

describe("the collapsible search", () => {
  it("shows only the icon until it is clicked", async () => {
    renderBar();
    expect(input()).toBeNull();

    await userEvent.click(icon());

    expect(document.activeElement).toBe(input());
  });

  it("closes when focus leaves it empty", async () => {
    renderBar();
    await userEvent.click(icon());

    await userEvent.click(screen.getByText("elsewhere"));

    expect(input()).toBeNull();
    expect(icon()).toBeTruthy();
  });

  it("stays open with text in it", async () => {
    renderBar();
    await userEvent.click(icon());
    await userEvent.keyboard("invoice");

    await userEvent.click(screen.getByText("elsewhere"));

    expect((input() as HTMLInputElement).value).toBe("invoice");
  });

  it("stays open while the text is deleted", async () => {
    renderBar();
    await userEvent.click(icon());
    await userEvent.keyboard("a{Backspace}");

    expect(document.activeElement).toBe(input());
  });

  it.each([
    {
      name: "Escape",
      close: () => userEvent.keyboard("{Escape}"),
    },
    {
      name: "the clear button",
      close: () =>
        userEvent.click(screen.getByRole("button", { name: "Clear search" })),
    },
  ])("clears and closes on $name", async ({ close }) => {
    renderBar();
    await userEvent.click(icon());
    await userEvent.keyboard("invoice");

    await close();

    expect(input()).toBeNull();
  });

  it("opens with an active search showing, without taking focus", () => {
    h.initialQuery = "invoice";
    renderBar();

    expect((input() as HTMLInputElement).value).toBe("invoice");
    expect(document.activeElement).not.toBe(input());
  });
});

describe("the plain search", () => {
  it("is always a box and does not take focus", () => {
    renderBar(false);

    expect(input()).not.toBeNull();
    expect(document.activeElement).not.toBe(input());
  });
});
