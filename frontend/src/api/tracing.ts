import { apiFetchJson } from "./client";

// Mirrors backend/crates/wayve-server/src/routes/tracing.rs — an aggregate of
// the tail of logs/tracing.log. Platform-owner only.

export type TracingTimelinePoint = {
  t: string;
  INFO: number;
  WARN: number;
  ERROR: number;
  DEBUG: number;
  other: number;
};

export type TargetCount = { target: string; count: number };

export type SlowSpan = {
  ts: string;
  target: string;
  span: string | null;
  busy_ms: number;
  message: string | null;
};

export type TraceEntry = {
  ts: string;
  level: string;
  target: string;
  span: string | null;
  message: string | null;
};

export type TracingOverview = {
  total: number;
  levels: Record<string, number>;
  timeline: TracingTimelinePoint[];
  top_targets: TargetCount[];
  slowest: SlowSpan[];
  recent: TraceEntry[];
};

export const getTracingOverview = (level?: string) => {
  const qs = level ? `?level=${encodeURIComponent(level)}` : "";
  return apiFetchJson<TracingOverview>(`/api/platform/tracing-overview${qs}`, {
    preserve401: true,
  });
};
