import { Link } from "react-router-dom";
import {
  peelTaskRefTrailing,
  taskRefPath,
} from "../../tasks/taskShareLink";

// Bare URLs and task references (`#42 Task name`) become links. Same-origin URLs and
// task refs use router links so the click navigates client-side; external URLs open in
// a new tab.
const TOKEN_RE = /https?:\/\/[^\s]+|#\d+\s+[^\n#]+/g;

function splitTrailing(url: string): [string, string] {
  const m = url.match(/[),.;:!?]+$/);
  if (!m) return [url, ""];
  return [url.slice(0, -m[0].length), m[0]];
}

type Token =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "taskRef"; ref: number; label: string; trailing: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: "text", value: text.slice(last, index) });
    }
    if (value.startsWith("http")) {
      tokens.push({ kind: "url", value });
    } else {
      const parsed = /^#(\d+)\s+(.+)$/.exec(value);
      if (parsed) {
        const ref = Number(parsed[1]);
        const [name, trailing] = peelTaskRefTrailing(parsed[2]);
        tokens.push({
          kind: "taskRef",
          ref,
          label: `#${ref} ${name}`,
          trailing,
        });
      } else {
        tokens.push({ kind: "text", value });
      }
    }
    last = index + value.length;
  }
  if (last < text.length) {
    tokens.push({ kind: "text", value: text.slice(last) });
  }
  return tokens;
}

export default function MessageText({ text }: { text: string }) {
  const tokens = tokenize(text);
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === "text") {
          return <span key={i}>{token.value}</span>;
        }
        if (token.kind === "taskRef") {
          return (
            <span key={i}>
              <Link className="message-link" to={taskRefPath(token.ref)}>
                {token.label}
              </Link>
              {token.trailing}
            </span>
          );
        }
        const [url, trailing] = splitTrailing(token.value);
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
