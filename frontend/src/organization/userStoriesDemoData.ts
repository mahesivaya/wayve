import type { Task } from "../api/tasks";
import type { StoryStatusEvent } from "../api/userStories";

// Dev-only stand-in stories for the timeline card.
//
// A local database is usually seeded only with whatever was created today, so
// stepping back through earlier sprints shows nothing and the navigation can't
// be exercised. When the dev server is running and a sprint window turns up
// genuinely empty, the card fills that window with these instead — never in a
// production build, and never over real data.
//
// The set is derived from the window's own start date rather than randomised,
// so the same sprint always renders the same stories: a screenshot taken twice
// matches, and a layout bug stays reproducible.

export const DEMO_DATA_ENABLED = import.meta.env.DEV;

const TITLES = [
  "Ride receipts by email",
  "Driver onboarding checklist",
  "Surge pricing rules engine",
  "Passenger can split a fare",
  "Offline map tiles",
  "Refund flow for cancelled trips",
  "Spanish localization pass",
  "Trip history export",
  "Push notification preferences",
  "Fraud signals dashboard",
  "Accessibility audit fixes",
  "Driver payout schedule",
];

// Each entry is one story's shape within the window, as a fraction of the
// sprint: where it starts, how long it runs, and which status column it is in.
const PATTERN: { at: number; len: number; status: number }[] = [
  { at: 0.0, len: 0.3, status: 3 },
  { at: 0.05, len: 0.35, status: 3 },
  { at: 0.1, len: 0.45, status: 3 },
  { at: 0.2, len: 0.4, status: 2 },
  { at: 0.3, len: 0.45, status: 1 },
  { at: 0.45, len: 0.4, status: 1 },
  { at: 0.6, len: 0.35, status: 0 },
];

// Local-midnight ISO without a zone, matching how the backend serialises its
// naive timestamps — the card parses both the same way.
function isoLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:00`
  );
}

/**
 * A demo sprint spanning `[cycleStart, cycleStart + cycleDays)`: the stories as
 * the card would have received them from the API, plus the status history that
 * cuts each bar into its blocks. `statusSlugs` is the owner's real status list
 * (board order, completed last) so the blocks carry real colours.
 */
export function demoSprint(
  cycleStart: number,
  cycleDays: number,
  statusSlugs: string[]
): { stories: Task[]; timeline: Map<number, StoryStatusEvent[]> } {
  if (statusSlugs.length === 0) return { stories: [], timeline: new Map() };
  const dayMs = 86_400_000;
  const windowMs = cycleDays * dayMs;
  // A stable per-window seed: the sprint's day number. Rotating the title list
  // by it keeps each sprint distinguishable without any randomness.
  const seed = Math.floor(cycleStart / dayMs);
  // Clamp into the real status list so a board with fewer columns still maps.
  const slug = (i: number) => statusSlugs[Math.min(i, statusSlugs.length - 1)];

  const stories: Task[] = [];
  const timeline = new Map<number, StoryStatusEvent[]>();

  PATTERN.forEach((slot, i) => {
    const id = -(seed * 100 + i + 1); // negative: never collides with a real row
    const start = cycleStart + Math.round(slot.at * windowMs) + 9 * 3_600_000;
    const end = Math.min(
      cycleStart + Math.round((slot.at + slot.len) * windowMs),
      cycleStart + windowMs - 1
    );

    stories.push({
      id,
      task_number: i + 1,
      name: TITLES[(seed + i) % TITLES.length],
      description: "",
      priority: ((seed + i) % 4) + 1,
      status: slug(slot.status),
      assigned_by: "",
      assignee: "",
      created_at: isoLocal(start),
      updated_at: isoLocal(end),
    } as Task);

    // The story walks the board from the first column to the one it ended in,
    // spending an equal share of its span in each — enough to show the blocks.
    const steps = slot.status + 1;
    timeline.set(
      id,
      Array.from({ length: steps }, (_, step) => ({
        at: isoLocal(start + Math.round(((end - start) * step) / steps)),
        status: slug(step),
      }))
    );
  });

  return { stories, timeline };
}
