import { Link } from "react-router-dom";

// Renders message body text with bare URLs turned into clickable links. Links
// that point back into this app (same origin — e.g. a copied task link like
// `…/tasks?task=42`) render as in-app router links so a click navigates
// client-side to that page (the Tasks page opens the linked task's details
// straight away); everything else opens in a new tab. Plain text without URLs
// falls through unchanged.
const URL_RE = /(https?:\/\/[^\s]+)/g;

// URLs often sit next to punctuation ("see https://x.com."). Peel trailing
// characters that are almost never part of the link back into plain text so the
// anchor doesn't swallow them.
function splitTrailing(url: string): [string, string] {
  const m = url.match(/[),.;:!?]+$/);
  if (!m) return [url, ""];
  return [url.slice(0, -m[0].length), m[0]];
}

export default function MessageText({ text }: { text: string }) {
  // String.split with a capturing group interleaves plain text (even indices)
  // and the captured URLs (odd indices).
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const [url, trailing] = splitTrailing(part);
        let internal: string | null = null;
        try {
          const u = new URL(url);
          if (u.origin === window.location.origin) {
            internal = u.pathname + u.search + u.hash;
          }
        } catch {
          // Unparseable — fall through and render as a plain external anchor.
        }
        return (
          <span key={i}>
            {internal ? (
              <Link className="message-link" to={internal}>
                {url}
              </Link>
            ) : (
              <a
                className="message-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {url}
              </a>
            )}
            {trailing}
          </span>
        );
      })}
    </>
  );
}
