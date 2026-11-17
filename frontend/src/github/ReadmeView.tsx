import { useEffect, useState } from "react";
import { loadMarked, renderUntrustedMarkdown } from "../utils/markdown";

// A repository's README, formatted like the rest of the app's documents rather
// than shown as Markdown source. The text comes from whoever wrote the repo, so
// it goes through renderUntrustedMarkdown (sanitized, links open in a new tab).
// Relative links and images resolve against the repo on GitHub.
export default function ReadmeView({
  markdown,
  linkBase,
  imageBase,
}: {
  markdown: string;
  linkBase?: string;
  imageBase?: string;
}) {
  // The rendered HTML, tagged with the source it came from so a stale render
  // never shows for a newer README. null until marked has loaded.
  const [rendered, setRendered] = useState<{
    source: string;
    html: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadMarked()
      .then((parse) => {
        if (cancelled) return;
        setRendered({
          source: markdown,
          html: renderUntrustedMarkdown(parse, markdown, {
            linkBase,
            imageBase,
          }),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [markdown, linkBase, imageBase]);

  if (failed) {
    return <pre className="github-description-readme">{markdown}</pre>;
  }
  if (rendered?.source !== markdown) {
    return <div className="github-empty">Formatting README…</div>;
  }
  return (
    <article
      className="github-readme-rendered"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
