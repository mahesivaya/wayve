// PR merge box: GitHub's Checks / Comments / Approvals summary on the in-app
// pull request page.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PrMergeBox from "../../github/PrMergeBox";
import {
  checkDuration,
  sortChecks,
  summarizeApprovals,
  summarizeChecks,
  type CheckRun,
} from "../../github/prMergeSummary";

const run = (
  id: number,
  status: string,
  conclusion: string | null
): CheckRun => ({ id, name: `job ${id}`, status, conclusion });

const PR = {
  state: "open",
  merged: false,
  mergeable: false,
  mergeable_state: "dirty",
  html_url: "https://github.com/o/r/pull/232",
};

describe("summarizeChecks", () => {
  it("buckets runs as GitHub does", () => {
    expect(
      summarizeChecks([
        run(1, "completed", "success"),
        run(2, "completed", "neutral"),
        run(3, "completed", "failure"),
        run(4, "completed", "timed_out"),
        run(5, "completed", "cancelled"),
        run(6, "completed", "skipped"),
        run(7, "in_progress", null),
      ])
    ).toEqual({ total: 7, passed: 2, failing: 3, pending: 1, skipped: 1 });
  });
});

describe("summarizeApprovals", () => {
  it("keeps each reviewer's latest verdict", () => {
    const s = summarizeApprovals([
      {
        user: { login: "ann" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-11-01T00:00:00Z",
      },
      {
        user: { login: "ann" },
        state: "APPROVED",
        submitted_at: "2026-11-02T00:00:00Z",
      },
      {
        user: { login: "ann" },
        state: "COMMENTED",
        submitted_at: "2026-11-03T00:00:00Z",
      },
      {
        user: { login: "bob" },
        state: "APPROVED",
        submitted_at: "2026-11-01T00:00:00Z",
      },
      {
        user: { login: "bob" },
        state: "DISMISSED",
        submitted_at: "2026-11-02T00:00:00Z",
      },
      {
        user: { login: "cy" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-11-02T00:00:00Z",
      },
    ]);
    expect(s).toEqual({ approved: ["ann"], changesRequested: ["cy"] });
  });
});

describe("sortChecks / checkDuration", () => {
  it("puts failing checks first, then by name", () => {
    const sorted = sortChecks([
      { ...run(1, "completed", "success"), name: "10 · Summary" },
      { ...run(2, "completed", "failure"), name: "6 · Trivy filesystem" },
      { ...run(3, "completed", "success"), name: "1 · Secret scan" },
      { ...run(4, "completed", "failure"), name: "2 · Rust deps" },
    ]);
    expect(sorted.map((r) => r.name)).toEqual([
      "2 · Rust deps",
      "6 · Trivy filesystem",
      "1 · Secret scan",
      "10 · Summary",
    ]);
  });

  it("formats how long a check ran", () => {
    const at = (secs: number) => ({
      ...run(1, "completed", "success"),
      started_at: "2026-11-12T10:00:00Z",
      completed_at: new Date(
        Date.parse("2026-11-12T10:00:00Z") + secs * 1000
      ).toISOString(),
    });
    expect(checkDuration(at(14))).toBe("14s");
    expect(checkDuration(at(550))).toBe("9m 10s");
    expect(checkDuration(run(1, "in_progress", null))).toBeNull();
  });
});

afterEach(() => vi.restoreAllMocks());

const COMMENT = {
  id: 1,
  user: { login: "ann" },
  body: "Looks good overall,\n  one nit below.",
  created_at: "2026-11-10T10:00:00Z",
  html_url: "https://github.com/o/r/pull/232#issuecomment-1",
};
const LINE_COMMENT = {
  id: 2,
  user: { login: "bob" },
  body: "Rename this?",
  created_at: "2026-11-11T10:00:00Z",
  html_url: "https://github.com/o/r/pull/232#discussion_r2",
  path: "src/app.ts",
};

describe("PrMergeBox", () => {
  it("shows the conflict headline and the three summaries", () => {
    render(
      <PrMergeBox
        pr={PR}
        checkRuns={[
          run(1, "completed", "success"),
          run(2, "completed", "failure"),
          run(3, "completed", "skipped"),
        ]}
        reviews={[]}
        comments={[COMMENT, LINE_COMMENT]}
      />
    );

    expect(screen.queryByText("Merge conflicts")).toBeNull();
    expect(screen.queryByText("Ready to merge")).toBeNull();
    expect(screen.getByRole("img", { name: "Checks: 1 failing" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Comments: 2 comments" })
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Approvals: None yet" })
    ).toBeTruthy();
  });

  it("lists checks and asks before opening one on GitHub Actions", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <PrMergeBox
        pr={PR}
        checkRuns={[
          {
            ...run(1, "completed", "success"),
            name: "1 · Secret scan",
            html_url: "https://github.com/o/r/actions/runs/9/job/1",
          },
          {
            ...run(2, "completed", "failure"),
            name: "2 · Rust deps",
            html_url: "https://github.com/o/r/actions/runs/9/job/2",
          },
        ]}
        reviews={[]}
        comments={[]}
      />
    );

    const list = screen.getByRole("dialog", { name: "Checks", hidden: true });
    const items = Array.from(list.querySelectorAll(".pr-checks-name")).map(
      (el) => el.textContent
    );
    expect(items).toEqual(["2 · Rust deps", "1 · Secret scan"]);

    fireEvent.click(screen.getByText("2 · Rust deps"));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("Open on GitHub?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Yes", hidden: true }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/o/r/actions/runs/9/job/2",
      "_blank",
      "noopener"
    );
  });

  it("No closes the prompt without leaving the app", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <PrMergeBox
        pr={PR}
        checkRuns={[
          {
            ...run(1, "completed", "success"),
            name: "1 · Secret scan",
            html_url: "https://x/1",
          },
        ]}
        reviews={[]}
        comments={[]}
      />
    );
    fireEvent.click(screen.getByText("1 · Secret scan"));
    fireEvent.click(screen.getByRole("button", { name: "No", hidden: true }));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("1 · Secret scan")).toBeTruthy();
  });

  it("says when check runs couldn't be loaded", () => {
    render(<PrMergeBox pr={PR} checkRuns={null} reviews={[]} comments={[]} />);
    expect(
      screen.getByRole("img", { name: "Checks: Unavailable" })
    ).toBeTruthy();
  });

  it("lists comments and asks Yes/No before opening one on GitHub", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <PrMergeBox
        pr={PR}
        checkRuns={[]}
        reviews={[]}
        comments={[LINE_COMMENT, COMMENT]}
      />
    );

    const list = screen.getByRole("dialog", { name: "Comments", hidden: true });
    expect(
      Array.from(list.querySelectorAll(".pr-checks-text")).map(
        (el) => el.textContent
      )
    ).toEqual([
      "annLooks good overall, one nit below.",
      "bobsrc/app.ts: Rename this?",
    ]);

    fireEvent.click(screen.getByText("bob"));
    expect(screen.getByText("bob's comment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes", hidden: true }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/o/r/pull/232#discussion_r2",
      "_blank",
      "noopener"
    );
  });

  it("lists each reviewer's latest verdict under Approvals", () => {
    render(
      <PrMergeBox
        pr={PR}
        checkRuns={[]}
        comments={[]}
        reviews={[
          {
            user: { login: "ann" },
            state: "APPROVED",
            submitted_at: "2026-11-10T10:00:00Z",
            html_url: "https://github.com/o/r/pull/232#pullrequestreview-1",
          },
          {
            user: { login: "cy" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-11-11T10:00:00Z",
            html_url: "https://github.com/o/r/pull/232#pullrequestreview-2",
          },
        ]}
      />
    );
    const list = screen.getByRole("dialog", {
      name: "Approvals",
      hidden: true,
    });
    expect(
      Array.from(list.querySelectorAll(".pr-checks-text")).map(
        (el) => el.textContent
      )
    ).toEqual(["annApproved", "cyRequested changes"]);
  });

  it("shows no list for an empty cell", () => {
    render(<PrMergeBox pr={PR} checkRuns={[]} reviews={[]} comments={[]} />);
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  });
});
