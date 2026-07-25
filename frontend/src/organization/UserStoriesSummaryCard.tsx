import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getUserStories,
  USER_STORIES_CHANGED_EVENT,
} from "../api/userStories";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
import type { Task } from "../api/tasks";
import { useAuth } from "../auth/useAuth";
import {
  DEMO_DATA_ENABLED,
  demoStoriesForCycle,
} from "./userStoriesDemoData";
import "./userStoriesSummaryCard.css";

// A timeline of the team's user stories across the current sprint (cycle): one
// horizontal bar per story, running from when it was created to when it was
// completed — or to the right edge while it is still open — over a date axis of
// the cycle's days. Each bar takes its status's colour, so where a story sits on
// the board and how long it has been running read together.
//
// A span chart rather than trend lines because the thing being tracked is a set
// of overlapping date ranges: a line has to collapse them to a daily count
// first, which is exactly the information ("which story, running how long")
// that makes the sprint legible.
//
// Bars are clipped to the cycle window, so a story that started before it opens
// flush against the left edge. "Total points" (sum of priorities) stays as a
// headline scalar — a different measure from durations, so it never shares an
// axis with them.

const DEFAULT_CYCLE_DAYS = 14;
// Cycles are fixed blocks measured from this Monday, so boundaries are stable.
const CYCLE_ANCHOR = new Date("2026-01-05T00:00:00");
const DAY_MS = 86_400_000;
const AXIS_INK = "#94a3b8"; // muted gray, legible on both admin surfaces
const GRID_INK = "rgba(148,163,184,0.18)";
// Bar geometry: a capped thickness (the rest of the row's band stays air) and a
// 4px radius on both ends — unlike a column off a baseline, a span has two data
// ends and neither is anchored.
const MAX_BAR_WIDTH = 14;
const BAR_RADIUS = 4;
// Row height the chart is sized from, so the card grows with the story count
// instead of squeezing every story into a fixed box.
const ROW_HEIGHT = 26;
// The date axis above the rows, plus the strip below them the "Today" marker
// names itself in — both outside the plotted rows.
const CHART_CHROME = 62;
const LABEL_WIDTH = 176; // axis gutter the story titles are drawn into
// The chart's own left+right margins, excluded (with the gutter) when turning a
// drag in pixels into a shift in days.
const SIDE_MARGINS = 18;
const MAX_ROWS = 12; // keep the summary card a summary; the board has them all
// A story that starts and ends the same day would otherwise have zero width.
const MIN_SPAN_MS = DAY_MS / 3;
// Long titles are truncated in the data rather than left to overflow the axis
// gutter, where they would be clipped mid-word by the SVG edge.
const MAX_LABEL_CHARS = 24;
// Row fields. `offset` is an invisible spacer bar that pushes the visible
// `span` bar to its start date — the standard way to place a range in a
// cartesian bar chart. Both are durations measured from the cycle's start, so
// the value axis is relative and its ticks are formatted back into dates.
const OFFSET_KEY = "offset";
const SPAN_KEY = "span";

type TimelineRow = {
  label: string;
  [OFFSET_KEY]: number;
  [SPAN_KEY]: number;
  color: string;
  statusName: string;
  startMs: number;
  endMs: number;
  running: boolean;
  points: number;
};

type SegmentProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
};

// A story's span. Both ends are rounded because both are data — there is no
// baseline here for a square end to sit on.
function SpanBar({ x = 0, y = 0, width = 0, height = 0, fill }: SegmentProps) {
  if (height <= 0 || width <= 0) return null;
  const r = Math.min(BAR_RADIUS, height / 2, width / 2);
  const right = x + width;
  const bottom = y + height;
  const d =
    `M${x + r},${y} L${right - r},${y} Q${right},${y} ${right},${y + r} ` +
    `L${right},${bottom - r} Q${right},${bottom} ${right - r},${bottom} ` +
    `L${x + r},${bottom} Q${x},${bottom} ${x},${bottom - r} ` +
    `L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
  return <path d={d} fill={fill} />;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function currentCycleStart(today: Date, cycleDays: number): number {
  const anchor = startOfDay(CYCLE_ANCHOR);
  const elapsedDays = Math.floor((startOfDay(today) - anchor) / DAY_MS);
  const cycleIndex = Math.floor(elapsedDays / cycleDays);
  return anchor + cycleIndex * cycleDays * DAY_MS;
}

const fmtRange = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

// The backend serialises timestamps without a zone offset; parsed as-is they are
// read as local time, which is what the cycle window is measured in too.
function parseTs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Turns stories into timeline rows against the window `[windowStart, windowEnd]`,
 * dropping the ones that don't overlap it and clipping the rest to its edges.
 * `now` is where an unfinished story's bar ends.
 *
 * A plain function rather than inline in the memo because both the real stories
 * and the dev stand-ins go through it — one definition of what a bar means.
 */
function buildRows(
  stories: Task[],
  statuses: TaskStatusRow[],
  windowStart: number,
  windowEnd: number,
  now: number
): TimelineRow[] {
  const byStatus = new Map(statuses.map((s) => [s.slug, s]));

  const built = stories.flatMap((story) => {
    const created = parseTs(story.created_at);
    if (created === null) return [];
    const status = byStatus.get(story.status);
    // A finished story's span ends when it was last touched; an open one is
    // still running, so it reaches `now` (clipped to the window below).
    const finished =
      status?.category === "completed" || status?.category === "canceled";
    const ended = finished ? (parseTs(story.updated_at) ?? now) : now;

    const startMs = Math.max(created, windowStart);
    const endMs = Math.min(Math.max(ended, created + MIN_SPAN_MS), windowEnd);
    if (endMs <= windowStart || startMs >= windowEnd) return [];

    const key = story.task_number != null ? `#${story.task_number} ` : "";
    const title =
      story.name.length > MAX_LABEL_CHARS
        ? `${story.name.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
        : story.name;
    return [
      {
        label: `${key}${title}`,
        [OFFSET_KEY]: startMs - windowStart,
        [SPAN_KEY]: Math.max(endMs - startMs, MIN_SPAN_MS),
        color: status?.color ?? AXIS_INK,
        statusName: status?.name ?? story.status,
        startMs,
        endMs,
        running: !finished,
        points: story.priority ?? 0,
      },
    ];
  });

  built.sort((a, b) => a.startMs - b.startMs || a.label.localeCompare(b.label));
  return built;
}

export default function UserStoriesSummaryCard() {
  const { user } = useAuth();
  const cycleDays = user?.organization_sprint_total_days ?? DEFAULT_CYCLE_DAYS;

  const cycleMs = cycleDays * DAY_MS;

  // How far the window on screen sits from the sprint running now, in ms. The
  // arrows move it a whole sprint at a time; dragging moves it a day at a time,
  // so the window is not tied to sprint boundaries — any date range is reachable.
  const [offsetMs, setOffsetMs] = useState(0);

  const cycle = useMemo(() => {
    const current = currentCycleStart(new Date(), cycleDays);
    const start = current + offsetMs;
    const end = start + cycleMs;
    const today = startOfDay(new Date());
    return {
      start,
      end,
      // Only mark today when the window on screen actually contains it.
      todayMs: today >= start && today <= end ? today : null,
    };
  }, [cycleDays, cycleMs, offsetMs]);

  // Drag-to-pan. The origin is a ref, not state: it is read by the move handler
  // and must not itself trigger a render on every pointer sample.
  const chartRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; offset: number; msPerPx: number } | null>(
    null
  );
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = chartRef.current;
    if (!el || event.button !== 0) return;
    // The bars occupy the container minus the label gutter and the chart's own
    // side margins; that width is what a pixel of drag is measured against.
    const plotWidth = el.clientWidth - LABEL_WIDTH - SIDE_MARGINS;
    if (plotWidth <= 0) return;
    dragRef.current = {
      x: event.clientX,
      offset: offsetMs,
      msPerPx: cycleMs / plotWidth,
    };
    // Optional: pointer capture keeps a drag alive when the cursor leaves the
    // plot, but jsdom (tests) doesn't implement it and it isn't essential.
    el.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Dragging right pulls earlier dates into view, like moving a sheet of
    // paper. Snapped to whole days so the axis keeps landing on date ticks.
    const shifted = drag.offset - (event.clientX - drag.x) * drag.msPerPx;
    setOffsetMs(Math.round(shifted / DAY_MS) * DAY_MS);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    chartRef.current?.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };

  const [stories, setStories] = useState<Task[] | null>(null);
  const [statuses, setStatuses] = useState<TaskStatusRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The instant the current data was read, which is where an unfinished story's
  // bar ends. Stamped on load rather than read while deriving the rows, so the
  // row build stays a pure function of state; it refreshes with the data.
  const [loadedAt, setLoadedAt] = useState(0);

  // A monotonically-increasing id so a slower earlier fetch can't clobber the
  // result of a newer one (e.g. a refetch triggered mid-flight by a story edit).
  const reqIdRef = useRef(0);
  const load = useCallback(() => {
    const myId = ++reqIdRef.current;
    Promise.all([getUserStories(), getTaskStatuses()])
      .then(([sts, statusRows]) => {
        if (reqIdRef.current !== myId) return;
        setStories(sts);
        setStatuses(statusRows);
        setLoadedAt(Date.now());
        setFailed(false);
      })
      .catch(() => {
        if (reqIdRef.current === myId) setFailed(true);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live-refresh: any story mutation dispatches the change event (instant, same
  // tab / split pane); a tab re-becoming visible catches edits made elsewhere.
  useEffect(() => {
    const onChange = () => load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener(USER_STORIES_CHANGED_EVENT, onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(USER_STORIES_CHANGED_EVENT, onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // One row per story whose span overlaps the sprint on screen, oldest start
  // first so the bars cascade down the window the way a sprint actually unfolds.
  const windowRows = useMemo<TimelineRow[]>(
    () =>
      stories && statuses
        ? buildRows(stories, statuses, cycle.start, cycle.end, loadedAt)
        : [],
    [stories, statuses, loadedAt, cycle.start, cycle.end]
  );

  // Dev only, and only for a window that is genuinely empty: a local database
  // rarely has anything in an earlier sprint, which would leave the navigation
  // with nothing to show. Real stories always win.
  const demoRows = useMemo<TimelineRow[]>(() => {
    if (!DEMO_DATA_ENABLED || !statuses || windowRows.length > 0) return [];
    return buildRows(
      demoStoriesForCycle(
        cycle.start,
        cycleDays,
        statuses.map((s) => s.slug)
      ),
      statuses,
      cycle.start,
      cycle.end,
      cycle.end // a demo sprint is history: nothing is still "running now"
    );
  }, [statuses, windowRows, cycle.start, cycle.end, cycleDays]);

  const showingDemo = demoRows.length > 0;
  const shownRows = showingDemo ? demoRows : windowRows;
  const rows = useMemo(
    () => shownRows.slice(0, MAX_ROWS),
    [shownRows]
  );

  // Points for the sprint on screen, not the whole backlog — so stepping back a
  // sprint re-reads the headline against the same window as the bars.
  const totalPoints = useMemo(
    () =>
      stories ? shownRows.reduce((sum, row) => sum + row.points, 0) : null,
    [stories, shownRows]
  );

  // Legend entries: only the statuses actually on the timeline, in board order.
  const legendStatuses = useMemo(() => {
    if (!statuses) return [];
    const present = new Set(rows.map((r) => r.statusName));
    return statuses.filter((s) => present.has(s.name));
  }, [statuses, rows]);

  // A tick every other day keeps the labels from colliding on a narrow card
  // while still marking the cycle's rhythm. Ticks are relative to the cycle's
  // start, like the bar values, and formatted back into dates on the axis.
  const span = cycle.end - cycle.start;
  const dayTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let ms = 0; ms <= span; ms += 2 * DAY_MS) ticks.push(ms);
    return ticks;
  }, [span]);

  const loading = !failed && stories === null;
  const empty = !failed && !loading && rows.length === 0;
  const hidden = windowRows.length - rows.length;
  // Dragging can leave the window between sprint boundaries, where no sprint
  // name is true; then the dates alone describe it.
  const sprints = offsetMs / cycleMs;
  const windowLabel = !Number.isInteger(sprints)
    ? "Custom range"
    : sprints === 0
      ? "Current sprint"
      : sprints === -1
        ? "Previous sprint"
        : sprints === 1
          ? "Next sprint"
          : sprints < 0
            ? `${-sprints} sprints ago`
            : `In ${sprints} sprints`;

  return (
    <article className="us-summary-card" aria-label="User stories timeline">
      <div className="us-summary-head">
        <div>
          <h3 className="us-summary-title">User Stories</h3>
          <p className="us-summary-sub">
            {windowLabel} · {fmtRange(cycle.start)}–{fmtRange(cycle.end)}
          </p>
        </div>
        <div className="us-summary-total" aria-hidden={failed}>
          <span className="us-summary-total-value">
            {failed ? "—" : (totalPoints ?? "…")}
          </span>
          <span className="us-summary-total-label">total points</span>
        </div>
      </div>

      {/* The sprint steppers flank the timeline rather than sitting in the
          header, so they read as "move the window under them". They wrap the
          empty and error states too — an empty sprint is exactly the one you
          need to step away from. */}
      <div className="us-summary-body">
        <button
          type="button"
          className="us-summary-nav-btn"
          onClick={() => setOffsetMs((ms) => ms - cycleMs)}
          aria-label="Previous sprint"
          title="Previous sprint"
        >
          ‹
        </button>

        <div className="us-summary-body-main">
          {failed ? (
            <p className="us-summary-empty">Couldn’t load user stories.</p>
          ) : loading ? (
            <p className="us-summary-empty">Loading…</p>
          ) : empty ? (
            <p className="us-summary-empty">No user stories in this sprint.</p>
          ) : (
            // Drag the plot to slide the window to any date range; the arrows
            // remain the keyboard-reachable path for the same move.
            <div
              ref={chartRef}
              className={`us-summary-chart${
                dragging ? " us-summary-chart--dragging" : ""
              }`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
          <ResponsiveContainer
            width="100%"
            height={rows.length * ROW_HEIGHT + CHART_CHROME}
          >
            <BarChart
              data={rows}
              // Horizontal spans: stories run down the category axis, dates run
              // along the value axis.
              layout="vertical"
              margin={{ top: 4, right: 14, bottom: 16, left: 4 }}
              barCategoryGap="22%"
            >
              {/* Only the date gridlines earn their ink — the story rows are
                  already separated by the gaps between bars. */}
              <CartesianGrid stroke={GRID_INK} horizontal={false} />
              <XAxis
                type="number"
                // Fixed to the cycle so every bar is placed against the same
                // window, whatever range the stories themselves happen to span.
                domain={[0, span]}
                ticks={dayTicks}
                // The dates read as a header above the work, as on a Gantt.
                orientation="top"
                tick={{ fill: AXIS_INK, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(rel: number) => fmtRange(cycle.start + rel)}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: AXIS_INK, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={LABEL_WIDTH}
                // Every story is its own row, so every row keeps its label.
                interval={0}
              />
              <Tooltip
                cursor={{ fill: "rgba(148,163,184,0.10)" }}
                contentStyle={{
                  background: "var(--color-surface, #fff)",
                  border: "1px solid var(--color-border, #e5e7eb)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                // The offset spacer is scaffolding, not data: report the span as
                // its dates and status instead of two raw millisecond numbers.
                formatter={(_value, _name, item) => {
                  const row = item?.payload as TimelineRow | undefined;
                  if (!row) return null;
                  const to = row.running ? "now" : fmtRange(row.endMs);
                  return [
                    `${fmtRange(row.startMs)} → ${to}`,
                    row.statusName,
                  ] as [string, string];
                }}
              />
              {cycle.todayMs !== null && (
                <ReferenceLine
                  x={cycle.todayMs - cycle.start}
                  stroke={AXIS_INK}
                  strokeDasharray="3 3"
                  label={{
                    value: "Today",
                    // The date axis owns the top of the plot and the story bars
                    // own its interior, so the marker names itself in the strip
                    // below — the one band nothing else can occupy.
                    position: "bottom",
                    fill: AXIS_INK,
                    fontSize: 10,
                  }}
                />
              )}
              {/* Invisible: it only pushes the span bar to its start date. */}
              <Bar
                dataKey={OFFSET_KEY}
                stackId="span"
                fill="transparent"
                isAnimationActive={false}
                legendType="none"
              />
              <Bar
                dataKey={SPAN_KEY}
                name="Story"
                stackId="span"
                maxBarSize={MAX_BAR_WIDTH}
                isAnimationActive={false}
                legendType="none"
                // recharts types a custom shape's props as `unknown`; what it
                // passes is the resolved bar geometry.
                shape={(props: unknown) => (
                  <SpanBar {...(props as SegmentProps)} />
                )}
              >
                {rows.map((row) => (
                  <Cell key={row.label} fill={row.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* The legend lives in the DOM rather than inside the SVG: recharts
              draws its own over the plot area, which would sit on top of the
              last story's bar once the chart height tracks the row count. */}
          <ul className="us-summary-legend">
            {legendStatuses.map((s) => (
              <li key={s.slug}>
                <span
                  className="us-summary-legend-swatch"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                {s.name}
              </li>
            ))}
          </ul>
          {hidden > 0 && (
                <p className="us-summary-more">+{hidden} more on the board</p>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="us-summary-nav-btn"
          onClick={() => setOffsetMs((ms) => ms + cycleMs)}
          aria-label="Next sprint"
          title="Next sprint"
        >
          ›
        </button>
      </div>
    </article>
  );
}
