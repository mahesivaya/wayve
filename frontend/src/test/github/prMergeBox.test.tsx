// PR merge box: GitHub's Checks / Comments / Approvals summary on the in-app
// pull request page.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PrMergeBox from "../../github/PrMergeBox";
import {
  mergeHeadline,
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

describe("mergeHeadline", () => {
  const none = summarizeChecks([]);
  it("reports conflicts, merged and clean states", () => {
    expect(mergeHeadline(PR, none).title).toBe("Merge conflicts");
    expect(mergeHeadline({ ...PR, merged: true }, none).title).toBe("Merged");
    expect(
      mergeHeadline({ ...PR, mergeable: true, mergeable_state: "clean" }, none)
    ).toMatchObject({ tone: "ok", title: "Ready to merge" });
    expect(
      mergeHeadline(
        { ...PR, mergeable: null, mergeable_state: "unknown" },
        none
      ).title
    ).toBe("Checking mergeability");
  });
});

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
        commentCount={2}
      />
    );

    expect(screen.getByText("Merge conflicts")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Checks: 1 failing" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Comments: 2 comments" })
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Approvals: None yet" })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Checks/ }).getAttribute("href")
    ).toBe("https://github.com/o/r/pull/232/checks");
  });

  it("says when check runs couldn't be loaded", () => {
    render(
      <PrMergeBox pr={PR} checkRuns={null} reviews={[]} commentCount={0} />
    );
    expect(
      screen.getByRole("img", { name: "Checks: Unavailable" })
    ).toBeTruthy();
  });
});
