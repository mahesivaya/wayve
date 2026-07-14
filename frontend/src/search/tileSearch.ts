// Shared matcher for the console/app tiles on the home dashboards. The header
// search box (see `SearchBar`) is rendered on every page, but a page only
// *does* something with the query if it reads it — the home pages used to
// ignore it, so the box looked broken there. Both admin homes filter their
// tiles through this.
//
// Matching is substring, case-insensitive, over the tile's visible text: the
// title AND the description, so "invoice" finds Billing even though the word
// only appears in its blurb.
export function matchesTileSearch(
  query: string,
  label: string,
  description?: string
): boolean {
  if (!query) return true;
  const haystack = `${label} ${description ?? ""}`.toLowerCase();
  return haystack.includes(query);
}
