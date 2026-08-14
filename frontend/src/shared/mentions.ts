// Shared `@mention` helpers used by both the chat composer and the email reply
// box. Kept dependency-free so either feature can import it without pulling in
// the other's module graph.

// Handles only — the default, and what chat wants: its mentions are display
// names, so a second `@` ends the mention.
const HANDLE_RE = /(?:^|\s)@([\w.-]*)$/;

// A whole email address may be typed as the query: a local part that can carry
// a `+tag` (and the `=` a bounce address folds the original address in with),
// optionally followed by one `@domain`. Neither class contains whitespace, so a
// mention still cannot run past the word it started in, and allowing exactly
// one inner `@` stops it swallowing a second address typed after it.
const ADDRESS_RE = /(?:^|\s)@([\w.+=%-]*(?:@[\w.-]*)?)$/;

/**
 * Finds an in-progress `@mention` immediately left of the caret, returning the
 * typed query and the index of the `@` so a replacement can be spliced in. The
 * `@` must start the line or follow whitespace, so a mid-word handle — or the
 * `@` inside an address already written out — doesn't trigger it.
 *
 * Pass `allowAddress` when the query itself may be an email address, as in the
 * email reply composer where you can filter contacts by typing one. It is
 * opt-in so chat, which shares this helper, keeps the narrower handle match.
 */
export function activeMention(
  text: string,
  caret: number,
  opts: { allowAddress?: boolean } = {}
): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const match = (opts.allowAddress ? ADDRESS_RE : HANDLE_RE).exec(upto);
  if (!match) return null;
  const query = match[1];
  return { query, start: caret - query.length - 1 };
}
