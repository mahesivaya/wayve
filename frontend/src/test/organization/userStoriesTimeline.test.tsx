// The user-stories timeline card. Its window is a sprint by default but is not
// bound to sprint boundaries: the side arrows step a whole sprint, and dragging
// the plot slides it a day at a time, so any date range is reachable.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, scope: "organization", organization_sprint_total_days: 14 },
  }),
}));

// ResponsiveContainer measures its parent, which is always 0×0 in jsdom, so it
// would render nothing. Fix the chart's size instead; the drag maths reads the
// wrapper's clientWidth, which is stubbed per-test below.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
      height,
    }: {
      children: React.ReactElement;
      height?: number | string;
    }) =>
      React.cloneElement(children, {
        width: 800,
        height: typeof height === "number" ? height : 200,
      }),
  };
});

const fx = vi.hoisted(() => {
  const STATUSES = [
    { id: 1, slug: "todo", name: "To Do", color: "#ec4899", category: "todo" },
    {
      id: 2,
      slug: "done",
      name: "Done",
      color: "#22c55e",
      category: "completed",
    },
  ];
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const anchor = startOfDay(new Date("2026-01-05T00:00:00"));
  const elapsed = Math.floor((startOfDay(new Date()) - anchor) / 86_400_000);
  const cycleStart = anchor + Math.floor(elapsed / 14) * 14 * 86_400_000;
  const iso = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00:00`;
  };
  // One story inside the current sprint, so the card has something to draw.
  const STORIES = [
    {
      id: 1,
      task_number: 7,
      name: "Ride receipts by email",
      description: "",
      priority: 3,
      status: "todo",
      assigned_by: "",
      assignee: "",
      created_at: iso(cycleStart + 86_400_000),
      updated_at: iso(cycleStart + 3 * 86_400_000),
    },
  ];
  return { STATUSES, STORIES, cycleStart };
});

vi.mock("../../api/userStories", () => ({
  USER_STORIES_CHANGED_EVENT: "rwayve:userstories-changed",
  getUserStories: vi.fn().mockResolvedValue(fx.STORIES),
}));

vi.mock("../../api/taskStatuses", () => ({
  getTaskStatuses: vi.fn().mockResolvedValue(fx.STATUSES),
}));

import UserStoriesSummaryCard from "../../organization/UserStoriesSummaryCard";

const fmt = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

// The subtitle is "<window label> · <from>–<to>", which is the readable proof of
// where the window sits.
const subtitle = () => screen.getByText(/·/).textContent ?? "";

// The drag maths divides the sprint by the plot's pixel width; jsdom reports 0
// for every layout box, so the wrapper needs a width to divide by.
function stubWidth(el: HTMLElement, width: number) {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
}

async function renderCard() {
  const { container } = render(<UserStoriesSummaryCard />);
  await screen.findByText("#7");
  const chart = container.querySelector(".us-summary-chart") as HTMLElement;
  return { chart, container };
}

describe("user stories timeline", () => {
  it("opens on the sprint running now", async () => {
    await renderCard();
    expect(subtitle()).toContain("Current sprint");
    expect(subtitle()).toContain(fmt(fx.cycleStart));
  });

  it("labels each row with the story number, not its title", async () => {
    await renderCard();
    // The gutter is narrow by design; the full name would have to be truncated
    // to fit, so it lives on the hover instead.
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.queryByText(/Ride receipts by email/)).toBeNull();
  });

  it("hovers the full title, and nothing else", async () => {
    const { container } = await renderCard();
    // Recharts needs a measured plot to resolve a pointer position to a row, so
    // drive the tooltip through the chart's own state rather than a real mouse
    // move — what is under test is the content it renders, not its hit-testing.
    const chart = container.querySelector(".recharts-wrapper") as HTMLElement;
    fireEvent.mouseOver(chart, { clientX: 300, clientY: 60 });
    fireEvent.mouseMove(chart, { clientX: 300, clientY: 60 });

    const tip = container.querySelector(".us-summary-tip");
    expect(tip).toBeTruthy();
    // The title alone: no dates, and none of the raw millisecond durations the
    // default tooltip would print for the spacer and span series.
    expect(tip?.textContent).toBe("Ride receipts by email");
    expect(tip?.textContent).not.toMatch(/\d/);
  });

  it("steps a whole sprint with the side arrows", async () => {
    await renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Previous sprint" }));
    expect(subtitle()).toContain("Previous sprint");
    expect(subtitle()).toContain(fmt(fx.cycleStart - 14 * 86_400_000));

    fireEvent.click(screen.getByRole("button", { name: "Next sprint" }));
    expect(subtitle()).toContain("Current sprint");

    fireEvent.click(screen.getByRole("button", { name: "Next sprint" }));
    expect(subtitle()).toContain("Next sprint");
    expect(subtitle()).toContain(fmt(fx.cycleStart + 14 * 86_400_000));
  });

  it("drags the window to a range between sprint boundaries", async () => {
    const { chart } = await renderCard();
    // 800px wide, minus the 52px number gutter and 18px of side margins, leaves
    // 730px of plot for a 14-day sprint — so a day is ~52px. Drag right 156px,
    // which is 3 days.
    stubWidth(chart, 800);

    fireEvent.pointerDown(chart, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(chart, { clientX: 400 + 156, pointerId: 1 });
    fireEvent.pointerUp(chart, { clientX: 556, pointerId: 1 });

    // Dragging right pulls earlier dates in, and lands off a sprint boundary —
    // so the window no longer answers to a sprint's name.
    expect(subtitle()).toContain("Custom range");
    expect(subtitle()).toContain(fmt(fx.cycleStart - 3 * 86_400_000));
  });

  it("keeps the drag on whole days", async () => {
    const { chart } = await renderCard();
    stubWidth(chart, 800);

    // A nudge smaller than half a day rounds away: the window does not drift by
    // fractions of a day, which would leave the axis ticks off-date.
    fireEvent.pointerDown(chart, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(chart, { clientX: 210, pointerId: 1 });
    fireEvent.pointerUp(chart, { clientX: 210, pointerId: 1 });

    expect(subtitle()).toContain("Current sprint");
    expect(subtitle()).toContain(fmt(fx.cycleStart));
  });
});
