// Shared `@mention` helpers used by both the chat composer and the email reply
// box. Kept dependency-free so either feature can import it without pulling in
// the other's module graph.

/**
 * Finds an in-progress `@mention` immediately left of the caret, returning the
 * typed query and the index of the `@` so a replacement can be spliced in. The
 * `@` must start the line or follow whitespace, so email addresses and mid-word
 * handles don't trigger it.
 */
export function activeMention(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const match = /(?:^|\s)@([\w.-]*)$/.exec(upto);
  if (!match) return null;
  const query = match[1];
  return { query, start: caret - query.length - 1 };
}
