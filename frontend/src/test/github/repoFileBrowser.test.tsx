// The Files tab walks folders like GitHub: one folder or one file at full width,
// with the path beside the heading to climb back up.
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
import { readRepoView, rememberOpenRepo } from "../../github/openRepoSession";

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
    body = [entry(".github", "dir"), entry("README.md", "file")];
  else if (url.endsWith(`${API}/contents/.github`))
    body = [entry(".github/workflows", "dir")];
  else if (url.endsWith(`${API}/contents/.github/workflows`))
    body = [entry(".github/workflows/ci.yml", "file")];
  else if (url.startsWith("https://raw.test/")) body = "name: ci";
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
  await screen.findByRole("button", { name: /\.github/ });
};
const pathBar = () => screen.getByRole("navigation", { name: "File path" });
const row = (name: RegExp) => screen.findByRole("button", { name });

describe("the Files tab", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    rememberOpenRepo(1, "acme/app");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts at the repo, with no way further up", async () => {
    await openFilesTab();
    expect(within(pathBar()).getByText("app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Parent folder" })).toBeNull();
  });

  it("opens a folder in place of the list and shows the path as links", async () => {
    await openFilesTab();
    await userEvent.click(await row(/\.github/));
    await userEvent.click(await row(/workflows/));
    await row(/ci\.yml/);

    expect(screen.queryByRole("button", { name: /README/ })).toBeNull();
    expect(within(pathBar()).getByRole("button", { name: "app" })).toBeTruthy();
    expect(
      within(pathBar()).getByRole("button", { name: ".github" })
    ).toBeTruthy();
    expect(
      within(pathBar()).getByText("workflows").getAttribute("aria-current")
    ).toBe("page");
  });

  it("climbs back with the path and the parent row", async () => {
    await openFilesTab();
    await userEvent.click(await row(/\.github/));
    await userEvent.click(await row(/workflows/));
    await row(/ci\.yml/);

    await userEvent.click(
      screen.getByRole("button", { name: "Parent folder" })
    );
    expect(await row(/workflows/)).toBeTruthy();

    await userEvent.click(
      within(pathBar()).getByRole("button", { name: "app" })
    );
    expect(await row(/README/)).toBeTruthy();
  });

  it("shows a file instead of the list, and closes back to its folder", async () => {
    await openFilesTab();
    await userEvent.click(await row(/\.github/));
    await userEvent.click(await row(/workflows/));
    await userEvent.click(await row(/ci\.yml/));

    await screen.findByRole("region", { name: "File preview" });
    await waitFor(() => expect(screen.getByText(/name/)).toBeTruthy());
    expect(
      screen.queryByRole("region", { name: "Repository files" })
    ).toBeNull();
    expect(
      within(pathBar()).getByText("ci.yml").getAttribute("aria-current")
    ).toBe("page");

    await userEvent.click(
      screen.getByRole("button", { name: "Close file preview" })
    );
    expect(await row(/ci\.yml/)).toBeTruthy();
    expect(
      within(pathBar()).getByText("workflows").getAttribute("aria-current")
    ).toBe("page");
  });

  it("copies the path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await openFilesTab();
    await userEvent.click(await row(/\.github/));
    await row(/workflows/);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith(".github");
    expect(screen.getByRole("button", { name: "Path copied" })).toBeTruthy();
  });

  it("remembers the folder", async () => {
    await openFilesTab();
    await userEvent.click(await row(/\.github/));
    await row(/workflows/);
    await waitFor(() =>
      expect(readRepoView(1, "acme/app")?.folders).toEqual([".github"])
    );
  });
});
