// Splits composer text into plain runs and `@mention` runs, so the reply box
// can paint the mentions without the surrounding prose.
//
// A <textarea> cannot style part of its own value, so the highlight is a mirror
// layer rendered behind a transparent textarea. That mirror needs the text cut
// into pieces — which is all this does. Keeping it a pure function means the
// interesting half is testable without fighting the alignment half.

/** Mirrors ADDRESS_RE in shared/mentions.ts: the mention forms that survive a
 *  round trip through the picker, including plus-tagged and bounce addresses.
 *  Unanchored and global here, since this scans finished text rather than what
 *  sits left of the caret. */
const MENTION_RE = /(^|\s)(@[\w.+=%-]+(?:@[\w.-]+)?)/g;

export type Run = { text: string; mention: boolean };

export function splitMentions(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;

  for (const match of text.matchAll(MENTION_RE)) {
    const [, lead, mention] = match;
    // matchAll on a /g regex always yields an index; the guard keeps TS happy
    // without an assertion.
    const start = (match.index ?? 0) + lead.length;
    if (start > last) runs.push({ text: text.slice(last, start), mention: false });
    runs.push({ text: mention, mention: true });
    last = start + mention.length;
  }

  if (last < text.length) {
    runs.push({ text: text.slice(last), mention: false });
  }
  return runs;
}
