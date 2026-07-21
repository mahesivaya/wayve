import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getUserStories,
  getUserStoryStatusHistory,
  type StatusHistoryDay,
} from "../api/userStories";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
import { useAuth } from "../auth/useAuth";
import "./userStoriesSummaryCard.css";

// A small graphical summary of the team's user stories over a fixed sprint
// (cycle) window. The chart draws one line per status (Todo / In Progress /
// In Review / Completed…), each in its own status colour, showing how many
// stories sit in that status on each day — the real burnup trend.
//
// The counts come from replayed status-change history, so the lines only carry
// true day-by-day movement from when recording started; earlier days rest on the
// backfilled day-0 baseline (each story's created_at → its current status).
// "Total points" (sum of priorities) stays as a headline scalar — a different
// measure from story counts, so it never shares the chart's axis.

const DEFAULT_CYCLE_DAYS = 14;
// Cycles are fixed blocks measured from this Monday, so boundaries are stable.
const CYCLE_ANCHOR = new Date("2026-01-05T00:00:00");
const DAY_MS = 86_400_000;
const AXIS_INK = "#94a3b8"; // muted gray, legible on both admin surfaces

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function currentCycleStart(today: Date, cycleDays: number): number {
  const anchor = startOfDay(CYCLE_ANCHOR);
  const elapsedDays = Math.floor((startOfDay(today) - anchor) / DAY_MS);
  const cycleIndex = Math.floor(elapsedDays / cycleDays);
  return anchor + cycleIndex * cycleDays * DAY_MS;
}

// Local YYYY-MM-DD (not toISOString, which would shift the date in some zones).
function isoDate(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const fmtRange = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
// The API date is a bare YYYY-MM-DD; parse it as local midnight so the label
// doesn't slip a day.
const fmtDayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

export default function UserStoriesSummaryCard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const cycleDays = user?.organization_sprint_total_days ?? DEFAULT_CYCLE_DAYS;

  const cycle = useMemo(() => {
    const start = currentCycleStart(new Date(), cycleDays);
    const end = start + cycleDays * DAY_MS;
    const elapsed = Math.floor((startOfDay(new Date()) - start) / DAY_MS);
    return {
      start,
      end,
      todayDay: elapsed >= 0 && elapsed <= cycleDays ? elapsed : null,
    };
  }, [cycleDays]);

  const [totalPoints, setTotalPoints] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<TaskStatusRow[] | null>(null);
  const [history, setHistory] = useState<StatusHistoryDay[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const from = isoDate(cycle.start);
    const to = isoDate(cycle.end);
    Promise.all([
      getUserStories(),
      getTaskStatuses(),
      getUserStoryStatusHistory(from, to),
    ])
      .then(([stories, sts, hist]) => {
        if (cancelled) return;
        setTotalPoints(stories.reduce((sum, s) => sum + (s.priority ?? 0), 0));
        setStatuses(sts);
        setHistory(hist);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cycle.start, cycle.end]);

  // Only draw a line for a status that actually appears in the window, so the
  // legend doesn't list empty statuses. Keep the owner's board order.
  const seriesStatuses = useMemo(() => {
    if (!statuses || !history) return [];
    const present = new Set<string>();
    for (const day of history) {
      for (const [slug, n] of Object.entries(day.counts)) {
        if (n > 0) present.add(slug);
      }
    }
    return statuses.filter((s) => present.has(s.slug));
  }, [statuses, history]);

  // One row per day, with a numeric field per drawn status (0-filled so each
  // line is continuous rather than gapped).
  const rows = useMemo(() => {
    if (!history) return [];
    return history.map((day) => {
      const row: Record<string, number | string> = {
        dateLabel: fmtDayLabel(day.date),
      };
      for (const s of seriesStatuses) row[s.slug] = day.counts[s.slug] ?? 0;
      return row;
    });
  }, [history, seriesStatuses]);

  const open = () => void navigate("/user-stories");
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const loading = !failed && history === null;
  const empty = !failed && !loading && seriesStatuses.length === 0;
  const todayLabel =
    cycle.todayDay !== null ? rows[cycle.todayDay]?.dateLabel : undefined;

  return (
    <article
      className="us-summary-card"
      role="button"
      tabIndex={0}
      aria-label="Open user stories"
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <div className="us-summary-head">
        <div>
          <h3 className="us-summary-title">User Stories</h3>
          <p className="us-summary-sub">
            By status · {fmtRange(cycle.start)}–{fmtRange(cycle.end)}
          </p>
        </div>
        <div className="us-summary-total" aria-hidden={failed}>
          <span className="us-summary-total-value">
            {failed ? "—" : (totalPoints ?? "…")}
          </span>
          <span className="us-summary-total-label">total points</span>
        </div>
      </div>

      {failed ? (
        <p className="us-summary-empty">Couldn’t load user stories.</p>
      ) : loading ? (
        <p className="us-summary-empty">Loading…</p>
      ) : empty ? (
        <p className="us-summary-empty">No user stories yet.</p>
      ) : (
        <div className="us-summary-chart">
          <ResponsiveContainer width="100%" height={172}>
            <LineChart
              data={rows}
              margin={{ top: 6, right: 8, bottom: 0, left: -20 }}
            >
              <CartesianGrid stroke="rgba(148,163,184,0.18)" vertical={false} />
              <XAxis
                dataKey="dateLabel"
                tick={{ fill: AXIS_INK, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(148,163,184,0.3)" }}
                interval={Math.max(0, Math.floor(cycleDays / 4))}
                minTickGap={16}
              />
              <YAxis
                tick={{ fill: AXIS_INK, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={30}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ stroke: "rgba(148,163,184,0.4)" }}
                contentStyle={{
                  background: "var(--color-surface, #fff)",
                  border: "1px solid var(--color-border, #e5e7eb)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              {todayLabel && (
                <ReferenceLine
                  x={todayLabel}
                  stroke={AXIS_INK}
                  strokeDasharray="3 3"
                  label={{
                    value: "Today",
                    position: "top",
                    fill: AXIS_INK,
                    fontSize: 10,
                  }}
                />
              )}
              {seriesStatuses.map((s) => (
                <Line
                  key={s.slug}
                  type="monotone"
                  dataKey={s.slug}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </article>
  );
}
