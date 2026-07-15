import type { Task } from "../api/tasks";

/** Plain-text share snippet copied from a task card, e.g. "#42 Ship the thing". */
export function taskShareText(
  task: Pick<Task, "id" | "task_number" | "name">
): string {
  const num = task.task_number ?? task.id;
  return `#${num} ${task.name}`;
}

/** In-app route that opens a task from a `#<n> …` reference in chat. */
export function taskRefPath(ref: number): string {
  return `/tasks?ref=${ref}`;
}

// `#42 Task name` — the number is task_number when present, otherwise the row id.
export const TASK_REF_RE = /#(\d+)\s+([^\n#]+)/g;

export function peelTaskRefTrailing(text: string): [string, string] {
  const m = text.match(/[),.;:!?]+$/);
  if (!m) return [text.trimEnd(), ""];
  return [text.slice(0, -m[0].length).trimEnd(), m[0]];
}
