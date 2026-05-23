// Lane assignment for overlapping events within a single day.
//
// Given a list of events with `start` / `end` (minutes from midnight), this
// returns a Map keyed by event id with each event's `lane` (column index)
// and `laneCount` (total columns in its overlap cluster). Renderers use
// those to position each event side-by-side at `left = lane/laneCount`
// and `width = 1/laneCount`, matching Google / Outlook column-splitting.

type EventForLayout = { id: number; start: number; end: number };

export type LaneAssignment = { lane: number; laneCount: number };

export function computeLanes<T extends EventForLayout>(
  events: T[],
): Map<number, LaneAssignment> {
  const result = new Map<number, LaneAssignment>();
  if (events.length === 0) return result;

  // Sort by start ascending, then end descending so the longest event
  // in a tie gets the first lane (visually anchors the cluster).
  const sorted = [...events].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  // Walk the sorted list, grouping events into clusters of mutually-
  // connected overlaps. A cluster ends as soon as we encounter an event
  // whose start is at-or-after every previous event's end.
  let cluster: T[] = [];
  let clusterEnd = -Infinity;
  const clusters: T[][] = [];

  for (const event of sorted) {
    if (event.start >= clusterEnd) {
      if (cluster.length > 0) clusters.push(cluster);
      cluster = [event];
      clusterEnd = event.end;
    } else {
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.end);
    }
  }
  if (cluster.length > 0) clusters.push(cluster);

  // Within each cluster, greedily assign each event to the first lane
  // whose previous event has already ended (free at this start time).
  // `lanes[i]` = the end-time of the last event placed in lane i.
  for (const c of clusters) {
    const lanes: number[] = [];
    const placements: Array<{ id: number; lane: number }> = [];
    for (const event of c) {
      let lane = lanes.findIndex((endTime) => endTime <= event.start);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(event.end);
      } else {
        lanes[lane] = event.end;
      }
      placements.push({ id: event.id, lane });
    }
    const laneCount = lanes.length;
    for (const { id, lane } of placements) {
      result.set(id, { lane, laneCount });
    }
  }

  return result;
}
