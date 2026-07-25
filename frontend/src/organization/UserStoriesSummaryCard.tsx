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
  getUserStoryStatusTimeline,
  USER_STORIES_CHANGED_EVENT,
  type StoryStatusEvent,
} from "../api/userStories";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
import type { Task } from "../api/tasks";
import { useAuth } from "../auth/useAuth";
import { useIsDarkTheme } from "../theme/useIsDarkTheme";
import { DEMO_DATA_ENABLED, demoSprint } from "./userStoriesDemoData";
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
// Axis gutter. It holds a story number ("#41"), not a title — the titles were
// truncated to fit and still ate a fifth of the card, which is width the spans
// themselves can use. The full title is on hover.
const LABEL_WIDTH = 52;
// The chart's own left+right margins, excluded (with the gutter) when turning a
// drag in pixels into a shift in days.
const SIDE_MARGINS = 18;
const MAX_ROWS = 12; // keep the summary card a summary; the board has them all
// A story that starts and ends the same day would otherwise have zero width.
const MIN_SPAN_MS = DAY_MS / 3;
// Row fields. `offset` is an invisible spacer bar that pushes the story's first
// block to its start date — the standard way to place a range in a cartesian
// bar chart. Everything is a duration measured from the window's start, so the
// value axis is relative and its ticks are formatted back into dates.
const OFFSET_KEY = "offset";
// One field per status block: seg0, seg1, … stacked left to right in the order
// the story passed through them. A row uses as many as it has and leaves the
// rest at zero, so every row can be plotted by the same set of series.
const segKey = (i: number) => `seg${i}`;
// A block thinner than this can't show its colour, so it is folded into the one
// before it rather than drawn as a sliver.
const MIN_BLOCK_MS = 30 * 60_000;

type StatusBlock = { status: string; color: string; ms: number };

type TimelineRow = {
  /** Unique per row; the category axis plots against this, never shows it. */
  key: string;
  /** What the axis shows: "#41", or "—" for a story with no number. */
  number: string;
  /** The full, untruncated story name — the axis has no room for it, so it is
   *  carried here for the hover tooltip. */
  title: string;
  [OFFSET_KEY]: number;
  /** The blocks in order, for colour lookup and the hover breakdown. */
  blocks: StatusBlock[];
  /** Index of the row's last block, so a block can tell whether it owns the
   *  bar's right cap. The first is always 0. */
  lastBlock: number;
  startMs: number;
  points: number;
  /** seg0, seg1, … — see `segKey`. */
  [seg: string]: unknown;
};

type SegmentProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  index: number;
  payload?: TimelineRow;
};

// One status block within a story's bar.
//
// The bar is a single span cut into blocks by the status changes inside it, so
// its length says how long the story ran and its colours say where that time
// went. Only the outer ends are rounded: an interior edge is shared with the
// next block, and rounding it would read as two separate bars.
function SpanBlock({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  fill,
  index,
  payload,
}: SegmentProps) {
  if (height <= 0 || width <= 0) return null;
  const last = payload?.lastBlock ?? 0;
  const isFirst = index === 0;
  const isLast = index === last;
  // A 2px gap in the surface separates touching blocks, but only where the
  // block is wide enough to survive losing it — a narrow one would disappear.
  const drawn = isLast || width < 8 ? width : width - 2;
  const rl = isFirst ? Math.min(BAR_RADIUS, height / 2, drawn / 2) : 0;
  const rr = isLast ? Math.min(BAR_RADIUS, height / 2, drawn / 2) : 0;
  const right = x + drawn;
  const bottom = y + height;
  const d =
    `M${x + rl},${y} L${right - rr},${y} ` +
    (rr ? `Q${right},${y} ${right},${y + rr} ` : "") +
    `L${right},${bottom - rr} ` +
    (rr ? `Q${right},${bottom} ${right - rr},${bottom} ` : "") +
    `L${x + rl},${bottom} ` +
    (rl ? `Q${x},${bottom} ${x},${bottom - rl} ` : "") +
    `L${x},${y + rl} ` +
    (rl ? `Q${x},${y} ${x + rl},${y} ` : "") +
    `Z`;
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

// A status colour is one value in the database, but it has to sit on two very
// different surfaces. The hue is the status's identity and is kept exactly;
// only lightness is moved, into the band that reads against the current
// background — bright on the dark surface, deep on the light one — with a
// saturation floor so a washed-out setting still arrives as a colour rather
// than a grey. Outside these bands a mid-tone chosen for one theme goes muddy
// on the other, which is what "adapt to the background" has to prevent.
const DARK_BAND = { min: 0.54, max: 0.74 };
const LIGHT_BAND = { min: 0.34, max: 0.52 };
const SATURATION_FLOOR = 0.35;

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const full =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const to255 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/** The status's colour, re-tuned to read on the surface it is drawn against. */
function adaptToSurface(hex: string | undefined, isDark: boolean): string {
  const hsl = hex ? hexToHsl(hex) : null;
  if (!hsl) return AXIS_INK;
  const band = isDark ? DARK_BAND : LIGHT_BAND;
  return hslToHex(
    hsl.h,
    Math.max(hsl.s, SATURATION_FLOOR),
    clamp(hsl.l, band.min, band.max)
  );
}

// Local YYYY-MM-DD (not toISOString, which would shift the date in some zones).
function isoDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The `from` the history request sends. It only has to predate any story, since
// the endpoint bounds its results by `to` alone.
const HISTORY_FLOOR = "2000-01-01";

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
 * Cuts a story's span into one block per status it was in, using its own status
 * history. The event *before* the span opens is what it was already in, so the
 * first block is never colourless; events inside the span end one block and
 * start the next. With no history at all (a story older than the recording, or
 * one that never moved) the span is a single block of its current status.
 *
 * Blocks too thin to show their colour are folded into the block before them —
 * a status held for minutes is a sliver, not information.
 */
function statusBlocks(
  story: Task,
  events: StoryStatusEvent[],
  spanStart: number,
  spanEnd: number,
  byStatus: Map<string, TaskStatusRow>,
  isDark: boolean
): StatusBlock[] {
  const colorOf = (slug: string) =>
    adaptToSurface(byStatus.get(slug)?.color, isDark);

  const stamped = events
    .map((e) => ({ at: parseTs(e.at), status: e.status }))
    .filter((e): e is { at: number; status: string } => e.at !== null)
    .sort((a, b) => a.at - b.at);

  // What it was in when the span opened: the last change at or before the
  // start, falling back to the first recorded status, then to its status now.
  const opening =
    stamped.filter((e) => e.at <= spanStart).at(-1)?.status ??
    stamped[0]?.status ??
    story.status;

  const cuts = stamped.filter((e) => e.at > spanStart && e.at < spanEnd);

  const blocks: StatusBlock[] = [];
  let at = spanStart;
  let status = opening;
  for (const cut of [...cuts, { at: spanEnd, status: "" }]) {
    const ms = cut.at - at;
    const previous = blocks.at(-1);
    if (ms < MIN_BLOCK_MS && previous) {
      previous.ms += ms;
    } else if (ms > 0) {
      // A repeat of the status already running is the same block continuing.
      if (previous && previous.status === status) previous.ms += ms;
      else blocks.push({ status, color: colorOf(status), ms });
    }
    at = cut.at;
    status = cut.status;
  }

  return blocks.length > 0
    ? blocks
    : [
        {
          status: opening,
          color: colorOf(opening),
          ms: Math.max(spanEnd - spanStart, MIN_SPAN_MS),
        },
      ];
}

/**
 * Turns stories into timeline rows against the window `[windowStart, windowEnd]`,
 * dropping the ones that don't overlap it and clipping the rest to its edges.
 * `now` is where an unfinished story's bar ends. `timeline` maps a story id to
 * its status history; a story missing from it just gets one block.
 *
 * A plain function rather than inline in the memo because both the real stories
 * and the dev stand-ins go through it — one definition of what a bar means.
 */
function buildRows(
  stories: Task[],
  statuses: TaskStatusRow[],
  timeline: Map<number, StoryStatusEvent[]>,
  windowStart: number,
  windowEnd: number,
  now: number,
  isDark: boolean
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

    const blocks = statusBlocks(
      story,
      timeline.get(story.id) ?? [],
      startMs,
      endMs,
      byStatus,
      isDark
    );

    const row: TimelineRow = {
      // The row's identity on the category axis. It is the story's id, not
      // anything on show: two stories can share a number (or have none), and
      // recharts would silently merge rows that share a category value.
      key: String(story.id),
      number: story.task_number != null ? `#${story.task_number}` : "—",
      title: story.name,
      [OFFSET_KEY]: startMs - windowStart,
      blocks,
      lastBlock: blocks.length - 1,
      startMs,
      points: story.priority ?? 0,
    };
    blocks.forEach((block, i) => {
      row[segKey(i)] = block.ms;
    });
    return [row];
  });

  built.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
  return built;
}

export default function UserStoriesSummaryCard() {
  const { user } = useAuth();
  // Re-tunes every block and swatch when the surface flips light or dark.
  const isDark = useIsDarkTheme();
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
  // Story id → its status history, for cutting each bar into blocks.
  const [timeline, setTimeline] = useState<Map<number, StoryStatusEvent[]>>(
    new Map()
  );
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
    // The history is fetched once for everything up to a horizon, not per
    // window: the endpoint bounds only by `to`, so a wider request is a superset
    // of a narrower one, and the window can then be dragged anywhere without a
    // refetch per day. A story has a handful of status changes, so this stays
    // small even over a long history.
    // `from` is required by the endpoint but does not bound what it returns, so
    // it is a floor rather than the window's own start.
    const from = HISTORY_FLOOR;
    const to = isoDate(Date.now() + 365 * DAY_MS);
    Promise.all([
      getUserStories(),
      getTaskStatuses(),
      // The blocks are an enrichment: if only the history fails, the card still
      // draws every bar as one block of its current status.
      getUserStoryStatusTimeline(from, to).catch(() => []),
    ])
      .then(([sts, statusRows, spans]) => {
        if (reqIdRef.current !== myId) return;
        setStories(sts);
        setStatuses(statusRows);
        setTimeline(new Map(spans.map((s) => [s.id, s.events])));
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
        ? buildRows(
            stories,
            statuses,
            timeline,
            cycle.start,
            cycle.end,
            loadedAt,
            isDark
          )
        : [],
    [stories, statuses, timeline, loadedAt, cycle.start, cycle.end, isDark]
  );

  // Dev only, and only for a window that is genuinely empty: a local database
  // rarely has anything in an earlier sprint, which would leave the navigation
  // with nothing to show. Real stories always win.
  const demoRows = useMemo<TimelineRow[]>(() => {
    if (!DEMO_DATA_ENABLED || !statuses || windowRows.length > 0) return [];
    const demo = demoSprint(
      cycle.start,
      cycleDays,
      statuses.map((s) => s.slug)
    );
    return buildRows(
      demo.stories,
      statuses,
      demo.timeline,
      cycle.start,
      cycle.end,
      cycle.end, // a demo sprint is history: nothing is still "running now"
      isDark
    );
  }, [statuses, windowRows, cycle.start, cycle.end, cycleDays, isDark]);

  const showingDemo = demoRows.length > 0;
  const shownRows = showingDemo ? demoRows : windowRows;
  const rows = useMemo(() => shownRows.slice(0, MAX_ROWS), [shownRows]);

  // Points for the sprint on screen, not the whole backlog — so stepping back a
  // sprint re-reads the headline against the same window as the bars.
  const totalPoints = useMemo(
    () =>
      stories ? shownRows.reduce((sum, row) => sum + row.points, 0) : null,
    [stories, shownRows]
  );

  // Row key → the number the axis prints for it.
  const numberByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row.number])),
    [rows]
  );

  // A tick for every day in the window. Ticks are relative to the cycle's start,
  // like the bar values, and formatted back into dates on the axis.
  const span = cycle.end - cycle.start;
  const dayTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let ms = 0; ms <= span; ms += DAY_MS) ticks.push(ms);
    return ticks;
  }, [span]);

  // One series per block position, sized to the busiest row. A row with fewer
  // blocks leaves the rest at zero, which recharts skips.
  const blockSeries = useMemo(
    () =>
      Array.from(
        { length: Math.max(0, ...rows.map((r) => r.blocks.length)) },
        (_, i) => i
      ),
    [rows]
  );

  // Key for the block colours, in board order and only for the statuses on
  // screen. It earns its space now that the colours carry meaning.
  const legendStatuses = useMemo(() => {
    if (!statuses) return [];
    const present = new Set(rows.flatMap((r) => r.blocks.map((b) => b.status)));
    return statuses
      .filter((s) => present.has(s.slug))
      // The same adaptation the blocks get, or the key would name a colour that
      // is not on the chart.
      .map((s) => ({ ...s, color: adaptToSurface(s.color, isDark) }));
  }, [statuses, rows, isDark]);

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
                // Every day is labelled, so only the day number is spelled out;
                // repeating the month fifteen times is noise, and at that
                // density the labels would start colliding. The month is named
                // where it is actually needed — the first tick, and wherever a
                // new month begins.
                tickFormatter={(rel: number) => {
                  const ms = cycle.start + rel;
                  return rel === 0 || new Date(ms).getDate() === 1
                    ? fmtRange(ms)
                    : String(new Date(ms).getDate());
                }}
              />
              <YAxis
                type="category"
                // Plotted against the row's unique key, but labelled with the
                // story number — so two stories that share a number (or have
                // none) still get a row each.
                dataKey="key"
                tickFormatter={(key: string) => numberByKey.get(key) ?? ""}
                tick={{ fill: AXIS_INK, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={LABEL_WIDTH}
                // Every story is its own row, so every row keeps its label.
                interval={0}
              />
              <Tooltip
                cursor={{ fill: "rgba(148,163,184,0.10)" }}
                // The axis has room for the number only, so the hover carries
                // the title — and nothing else. The default tooltip would list
                // the series values, which here are the spacer's and the span's
                // raw millisecond durations; the dates are already the axis the
                // bar is drawn against, so restating them earns nothing.
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as TimelineRow | undefined;
                  if (!active || !row) return null;
                  return <div className="us-summary-tip">{row.title}</div>;
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
              {/* One series per block position. They stack in order, so a row's
                  blocks lay out left to right in the sequence the story moved
                  through them; each row colours its own via a Cell. */}
              {blockSeries.map((i) => (
                <Bar
                  key={segKey(i)}
                  dataKey={segKey(i)}
                  stackId="span"
                  maxBarSize={MAX_BAR_WIDTH}
                  isAnimationActive={false}
                  legendType="none"
                  // recharts types a custom shape's props as `unknown`; what it
                  // passes is the resolved bar geometry.
                  shape={(props: unknown) => (
                    <SpanBlock {...(props as SegmentProps)} index={i} />
                  )}
                >
                  {rows.map((row) => (
                    <Cell
                      key={row.key}
                      fill={row.blocks[i]?.color ?? "transparent"}
                    />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
              {/* The colours mean something again, so they need a key. */}
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
