// How many tabs fit in the width, leaving room for "More" unless all of them do.
export function fittingTabs(
  tabWidths: number[],
  moreWidth: number,
  available: number,
  gap: number
): number {
  const total = tabWidths.reduce((sum, width) => sum + width + gap, -gap);
  if (total <= available) return tabWidths.length;
  let used = moreWidth;
  let fit = 0;
  for (const width of tabWidths) {
    used += width + gap;
    if (used > available) break;
    fit++;
  }
  return fit;
}

// The first tabs that fit, keeping the open section among them so the row always
// shows where you are.
export function splitTabs<T extends { id: string }>(
  items: T[],
  fit: number,
  activeId: string
): { shown: T[]; more: T[] } {
  if (fit >= items.length) return { shown: items, more: [] };
  const first = items.slice(0, fit);
  const active = items.find((item) => item.id === activeId);
  if (active && !first.includes(active)) first[fit - 1] = active;
  return {
    shown: first,
    more: items.filter((item) => !first.includes(item)),
  };
}
