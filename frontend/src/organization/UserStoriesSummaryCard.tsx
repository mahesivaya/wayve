import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getUserStories } from "../api/userStories";
import { useAuth } from "../auth/useAuth";
import "./userStoriesSummaryCard.css";

// A small graphical burnup for the team's user stories. "Points" is the sum of
// each story's priority (1–5, 5 = highest). Over a fixed two-week cycle we plot
// the *expected* cumulative completion — one dot per day rising in a straight
// line to the two-week total points — the ideal pace to finish the scope.
//
// This is the feasible, backend-free view: the stories table stores no
// completion timestamps, so the *actual* completed-per-day curve (as in Linear's
// progress chart) isn't reconstructable here — only the expected/ideal line is.

// Fallback when the org hasn't set a sprint length (or for personal/platform
// accounts with no org). Admins change it on /settings (1–90).
const DEFAULT_CYCLE_DAYS = 14;
// Cycles are fixed blocks measured from this Monday. Anchoring to a constant
// (rather than "today") keeps the cycle boundaries stable for everyone.
const CYCLE_ANCHOR = new Date("2026-01-05T00:00:00"); // a Monday
const DAY_MS = 86_400_000;
const ACCENT = "#6366f1"; // single-series accent; reads on light + dark surfaces
const AXIS_INK = "#94a3b8"; // muted gray, legible on both admin surfaces

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// The cycle that today falls into, measured from the fixed anchor in blocks of
// `cycleDays`.
function currentCycleStart(today: Date, cycleDays: number): number {
  const anchor = startOfDay(CYCLE_ANCHOR);
  const elapsedDays = Math.floor((startOfDay(today) - anchor) / DAY_MS);
  const cycleIndex = Math.floor(elapsedDays / cycleDays);
  return anchor + cycleIndex * cycleDays * DAY_MS;
}

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function UserStoriesSummaryCard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const cycleDays = user?.organization_sprint_total_days ?? DEFAULT_CYCLE_DAYS;
  const [totalPoints, setTotalPoints] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getUserStories()
      .then((stories) => {
        if (cancelled) return;
        // Points = sum of priority values across the stories in scope.
        setTotalPoints(stories.reduce((sum, s) => sum + (s.priority ?? 0), 0));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { data, cycleStart, cycleEnd, todayDay } = useMemo(() => {
    const start = currentCycleStart(new Date(), cycleDays);
    const total = totalPoints ?? 0;
    // Day 0 = start (0 pts) … day N = end (total pts): the straight ideal line.
    const rows = Array.from({ length: cycleDays + 1 }, (_, day) => ({
      day,
      dateMs: start + day * DAY_MS,
      dateLabel: fmtDay(start + day * DAY_MS),
      expected: Math.round((total * day) / cycleDays),
    }));
    const elapsed = Math.floor((startOfDay(new Date()) - start) / DAY_MS);
    return {
      data: rows,
      cycleStart: start,
      cycleEnd: start + cycleDays * DAY_MS,
      todayDay: elapsed >= 0 && elapsed <= cycleDays ? elapsed : null,
    };
  }, [totalPoints, cycleDays]);

  const open = () => void navigate("/user-stories");
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

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
            Expected burnup · {fmtDay(cycleStart)}–{fmtDay(cycleEnd)}
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
      ) : totalPoints === null ? (
        <p className="us-summary-empty">Loading…</p>
      ) : totalPoints === 0 ? (
        <p className="us-summary-empty">No user stories yet.</p>
      ) : (
        <div className="us-summary-chart">
          <ResponsiveContainer width="100%" height={148}>
            <LineChart
              data={data}
              margin={{ top: 6, right: 8, bottom: 0, left: -18 }}
            >
              <CartesianGrid
                stroke="rgba(148,163,184,0.18)"
                vertical={false}
              />
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
                width={34}
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
                labelFormatter={(l) => `Day — ${l}`}
                formatter={(v: number) => [`${v} pts`, "Expected done"]}
              />
              {todayDay !== null && (
                <ReferenceLine
                  x={data[todayDay]?.dateLabel}
                  stroke={AXIS_INK}
                  strokeDasharray="3 3"
                  label={{ value: "Today", position: "top", fill: AXIS_INK, fontSize: 10 }}
                />
              )}
              <Line
                type="linear"
                dataKey="expected"
                name="Expected done"
                stroke={ACCENT}
                strokeWidth={2}
                strokeDasharray="5 4"
                // One dot per day reads well for short sprints; for long ones
                // it overcrowds, so drop to a bare line past ~3 weeks.
                dot={cycleDays <= 21 ? { r: 3, fill: ACCENT, strokeWidth: 0 } : false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </article>
  );
}
