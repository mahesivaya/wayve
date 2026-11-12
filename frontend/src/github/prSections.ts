// Splits a pull request body into its Markdown heading sections, so the PR
// page can always show Summary and fold the rest (Changes, Testing, …).

export type DescriptionSection = { title: string; body: string };

export type SplitDescription = {
  /** Text before the first heading. */
  intro: string;
  sections: DescriptionSection[];
};

const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

export function splitDescription(body: string): SplitDescription {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const intro: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let inFence = false;
  for (const line of lines) {
    // A "#" inside a code block is not a heading.
    if (/^ {0,3}(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      sections.push({ title: m[1], lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    } else {
      intro.push(line);
    }
  }
  return {
    intro: intro.join("\n").trim(),
    sections: sections.map((s) => ({
      title: s.title,
      body: s.lines.join("\n").trim(),
    })),
  };
}

/** Sections shown open with no toggle. */
export function isAlwaysOpen(title: string): boolean {
  return title.trim().toLowerCase() === "summary";
}
