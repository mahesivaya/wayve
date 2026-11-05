// The repository and branch pickers: a button and a list the app styles itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SidebarPicker } from "../../github/SidebarPicker";

const OPTIONS = [
  { value: 1, label: "api" },
  { value: 2, label: "web" },
];

const renderPicker = (value: number | null = 1) => {
  const onChange = vi.fn();
  render(
    <div>
      <SidebarPicker
        label="Select a repository"
        listLabel="Repositories"
        icon={null}
        value={value}
        options={OPTIONS}
        onChange={onChange}
      />
      <button type="button">outside</button>
    </div>
  );
  return onChange;
};

const trigger = () =>
  screen.getByRole("button", { name: /^Select a repository/ });

afterEach(cleanup);

describe("SidebarPicker", () => {
  it("shows the current choice, with the list closed", () => {
    renderPicker();
    expect(trigger().getAttribute("aria-label")).toBe(
      "Select a repository: api"
    );
    expect(trigger().textContent).toContain("api");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lists every option, marks the current one, and picks another", async () => {
    const onChange = renderPicker();
    await userEvent.click(trigger());

    const list = screen.getByRole("listbox", { name: "Repositories" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);

    await userEvent.click(within(list).getByRole("button", { name: "web" }));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape and on a click outside", async () => {
    renderPicker();
    await userEvent.click(trigger());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays usable before a choice has loaded", () => {
    renderPicker(null);
    expect(trigger().textContent).not.toContain("api");
  });

  it("names a choice that isn't in the list", () => {
    renderPicker(99);
    expect(trigger().textContent).toContain("99");
  });
});
