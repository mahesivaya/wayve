// The Files tab's optional folder tree: off until switched on, remembered, and
// still there while a file is open, so another can be opened without going back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, scope: "platform", effective_role: "member" },
  }),
}));

import GitHubRepo from "../../github/GitHubRepo";
import { rememberOpenRepo } from "../../github/openRepoSession";

const API = "/api/github/repos/acme/app";
const entry = (path: string, type: "dir" | "file") => ({
  name: path.split("/").pop(),
  path,
  type,
  size: type === "file" ? 2048 : 0,
  download_url: type === "file" ? `https://raw.test/${path}` : null,
});

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input).split("?")[0];
  let body: unknown = [];
  if (url.endsWith(API))
    body = { default_branch: "main", full_name: "acme/app" };
  else if (url.endsWith(`${API}/branches`)) body = [{ name: "main" }];
  else if (url.endsWith(`${API}/contents`))
    body = [entry("backend", "dir"), entry("README.md", "file")];
  else if (url.endsWith(`${API}/contents/backend`))
    body = [
      entry("backend/crates", "dir"),
      entry("backend/Cargo.toml", "file"),
    ];
  else if (url.endsWith(`${API}/contents/backend/crates`))
    body = [entry("backend/crates/lib.rs", "file")];
  else if (url.startsWith("https://raw.test/")) body = "fn main() {}";
  else if (url.includes("/actions/runs"))
    body = { workflow_runs: [], total_count: 0 };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

const openFilesTab = async () => {
  render(
    <MemoryRouter initialEntries={["/github"]}>
      <Routes>
        <Route path="/github" element={<GitHubRepo />} />
      </Routes>
    </MemoryRouter>
  );
  await userEvent.click(await screen.findByRole("button", { name: /Files/ }));
  // With the tree on, the root shows in both the tree and the main pane.
  await screen.findAllByRole("button", { name: /README/ });
};
const tree = () => screen.getByRole("tree", { name: "File tree" });
const inTree = (name: RegExp) => within(tree()).findByRole("button", { name });
const showTree = () =>
  userEvent.click(screen.getByRole("button", { name: "Show file tree" }));

describe("the Files tab's folder tree", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    rememberOpenRepo(1, "acme/app");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is off until switched on, and the choice is remembered", async () => {
    await openFilesTab();
    expect(screen.queryByRole("tree")).toBeNull();

    await showTree();
    expect(await inTree(/backend/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Hide file tree" })
        .getAttribute("aria-pressed")
    ).toBe("true");

    cleanup();
    await openFilesTab();
    expect(tree()).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Hide file tree" })
    );
    expect(screen.queryByRole("tree")).toBeNull();
    cleanup();
    await openFilesTab();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("opens folders in place and keeps them beside an open file", async () => {
    await openFilesTab();
    await showTree();

    await userEvent.click(await inTree(/backend/));
    await userEvent.click(await inTree(/crates/));
    await userEvent.click(await inTree(/lib\.rs/));

    // The file is open in the main pane...
    const preview = await screen.findByRole("region", { name: "File preview" });
    await waitFor(() =>
      expect(within(preview).getByText(/fn main/)).toBeTruthy()
    );
    // ...and the folders are all still there, with the file marked.
    expect(await inTree(/README/)).toBeTruthy();
    expect(await inTree(/Cargo\.toml/)).toBeTruthy();
    const file = await inTree(/lib\.rs/);
    expect(file.className).toContain("is-active");

    // Another file opens straight from the tree.
    await userEvent.click(await inTree(/Cargo\.toml/));
    await waitFor(async () =>
      expect((await inTree(/Cargo\.toml/)).className).toContain("is-active")
    );
    expect((await inTree(/lib\.rs/)).className).not.toContain("is-active");
  });

  it("keeps its show/hide switch at the top of the tree", async () => {
    await openFilesTab();
    const main = screen.getByRole("region", { name: "Repository files" });
    // Hidden: the switch is in the Files header.
    expect(
      within(main).getByRole("button", { name: "Show file tree" })
    ).toBeTruthy();

    await showTree();
    const pane = screen.getByRole("complementary", { name: "Folders" });
    expect(
      within(pane).getByRole("button", { name: "Hide file tree" })
    ).toBeTruthy();
    expect(
      within(main).queryByRole("button", { name: /file tree/ })
    ).toBeNull();
  });

  it("closes a folder again, and leaves the main pane where it was", async () => {
    await openFilesTab();
    await showTree();
    await userEvent.click(await inTree(/backend/));
    await inTree(/Cargo\.toml/);
    await userEvent.click(await inTree(/backend/));
    expect(within(tree()).queryByRole("button", { name: /Cargo/ })).toBeNull();
    // The main pane still lists the repo root.
    expect(
      within(
        screen.getByRole("region", { name: "Repository files" })
      ).getByRole("button", { name: /README/ })
    ).toBeTruthy();
  });

  it("opens the folders leading to wherever the main pane goes", async () => {
    await openFilesTab();
    await showTree();
    const main = screen.getByRole("region", { name: "Repository files" });
    await userEvent.click(
      within(main).getByRole("button", { name: /backend/ })
    );
    // The tree follows: backend is open, showing what's inside.
    expect(await inTree(/crates/)).toBeTruthy();
    expect(
      (await inTree(/backend/)).closest("li")?.getAttribute("aria-expanded")
    ).toBe("true");
  });
});
