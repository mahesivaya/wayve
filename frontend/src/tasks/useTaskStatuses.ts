// Shared read-only access to the caller's configured task statuses.
//
// Three pages outside the tasks module (audit, the activity dashboard, and
// reminders) each used to carry their own copy of a four-entry
// `to_do → "To do"` label map. Those copies had already drifted apart in
// casing, and once statuses became user-defined they would have rendered raw
// slugs like `qa_review` for anything custom. This hook is the single place
// they resolve a slug from.
//
// Responses are cached for a minute at the client layer: statuses change rarely
// and several of these consumers can mount at once.

import { useEffect, useState } from "react";

import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";

export function useTaskStatuses(): {
  statuses: TaskStatusRow[];
  /** The display name for a slug, falling back to the slug itself. */
  label: (slug: string) => string;
} {
  const [statuses, setStatuses] = useState<TaskStatusRow[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await getTaskStatuses();
        if (alive) setStatuses(rows);
      } catch {
        // Falling back to raw slugs is a degraded but correct render; none of
        // these consumers should surface an error banner over a label lookup.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const label = (slug: string) =>
    statuses.find((s) => s.slug === slug)?.name ?? slug;

  return { statuses, label };
}
