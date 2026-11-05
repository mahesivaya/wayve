// `main` sorts late in a repo with many branches, so it must not depend on the
// first page of GitHub's alphabetical list.
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBranches, orderBranches } from "../../github/branchList";

const named = (...names: string[]) => names.map((name) => ({ name }));

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("fetchBranches", () => {
  const page = (url: string) =>
    Number(new URL(url, "http://x").searchParams.get("page"));
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` }));

  it("keeps fetching until a page comes back short", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        respond(page(String(input)) === 1 ? fullPage : named("main"))
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const branches = await fetchBranches("/api/github/repos/a/b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(branches).toHaveLength(101);
    expect(branches[100].name).toBe("main");
  });

  it("keeps what it has when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          page(String(input)) === 1 ? respond(fullPage) : respond({}, 500)
        )
      )
    );
    expect(await fetchBranches("/api/github/repos/a/b")).toHaveLength(100);
  });

  it("stops at a limit however many branches there are", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(respond(fullPage)));
    vi.stubGlobal("fetch", fetchMock);
    await fetchBranches("/api/github/repos/a/b");
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe("orderBranches", () => {
  it("puts the default first, once, and keeps the rest in order", () => {
    expect(orderBranches(named("a", "dev", "main"), "main", "main")).toEqual([
      "main",
      "a",
      "dev",
    ]);
  });

  it("lists the default even if it wasn't fetched", () => {
    expect(orderBranches(named("a"), "main", "main")).toEqual(["main", "a"]);
  });

  it("doesn't move a current branch that's already listed", () => {
    expect(orderBranches(named("a", "dev", "main"), "main", "dev")).toEqual([
      "main",
      "a",
      "dev",
    ]);
  });

  it("lists a current branch that wasn't fetched, after the default", () => {
    expect(orderBranches(named("a"), "main", "old")).toEqual([
      "main",
      "old",
      "a",
    ]);
  });

  it("copes with the repo not having loaded yet", () => {
    expect(orderBranches([], undefined, "")).toEqual([]);
  });
});
