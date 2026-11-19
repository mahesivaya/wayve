import { useState } from "react";
import { ChevronIcon } from "../icons";

export type PrCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
};

/**
 * A merge request's commits. A row shows the first line of the commit message,
 * cut short to fit; clicking it opens the whole message underneath, with its
 * line breaks, and clicking again closes it.
 */
export function PrCommitList({
  commits,
  formatDate,
}: {
  commits: PrCommit[];
  formatDate: (value: string) => string;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (sha: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(sha)) next.add(sha);
      return next;
    });

  return (
    <ul className="pr-commit-list">
      {commits.map((c) => {
        const isOpen = open.has(c.sha);
        const author = c.author?.login ?? c.commit.author?.name ?? "unknown";
        return (
          <li key={c.sha} className={`pr-commit${isOpen ? " is-open" : ""}`}>
            <div className="pr-commit-row">
              <button
                type="button"
                className="pr-commit-toggle"
                aria-expanded={isOpen}
                onClick={() => toggle(c.sha)}
              >
                <span
                  className={`github-tree-toggle${isOpen ? " open" : ""}`}
                  aria-hidden="true"
                >
                  <ChevronIcon size={14} />
                </span>
                <span className="pr-commit-message">
                  {c.commit.message.split("\n")[0]}
                </span>
                <span className="pr-commit-meta">
                  {author}
                  {c.commit.author?.date &&
                    ` · ${formatDate(c.commit.author.date)}`}
                </span>
              </button>
              <a
                className="pr-commit-sha"
                href={c.html_url}
                target="_blank"
                rel="noreferrer"
              >
                {c.sha.slice(0, 7)}
              </a>
            </div>
            {isOpen && (
              <pre className="pr-commit-full">{c.commit.message.trim()}</pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
