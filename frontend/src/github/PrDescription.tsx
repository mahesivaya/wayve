import { useState, type ReactNode } from "react";
import { ChevronIcon } from "../icons";
import { isAlwaysOpen, splitDescription } from "./prSections";
import "./prDescription.css";

type Props = {
  body: string;
  /** Renders a block of PR text (inline code, links). */
  renderText: (text: string) => ReactNode;
};

// The PR body, split on its headings: any intro text and the Summary section
// always show; every other section (Changes, Testing, …) starts folded behind
// a ▸ toggle. A body without headings shows as-is.
export default function PrDescription({ body, renderText }: Props) {
  const { intro, sections } = splitDescription(body);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="github-pr-descwrap">
      {intro && <div className="github-pr-desc">{renderText(intro)}</div>}
      {sections.map((s, i) => {
        if (isAlwaysOpen(s.title)) {
          return (
            <div key={i} className="github-pr-desc-section">
              <h3 className="github-pr-desc-heading">{s.title}</h3>
              {s.body && (
                <div className="github-pr-desc">{renderText(s.body)}</div>
              )}
            </div>
          );
        }
        const expanded = open.has(i);
        return (
          <div key={i} className="github-pr-desc-section">
            <button
              type="button"
              className="github-pr-desc-toggle"
              onClick={() => toggle(i)}
              aria-expanded={expanded}
            >
              <span className={`github-pr-chevron ${expanded ? "open" : ""}`}>
                <ChevronIcon />
              </span>
              {s.title}
            </button>
            {expanded && s.body && (
              <div className="github-pr-desc">{renderText(s.body)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
