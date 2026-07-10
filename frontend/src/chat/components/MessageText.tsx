import { Link } from "react-router-dom";
import { useSplitControl } from "../../components/SplitControlContext";

// Renders message body text with bare URLs turned into clickable links. Links
// that point back into this app (same origin — e.g. a copied task link like
// `…/tasks?task=42`) render as in-app router links so a click navigates
// client-side instead of doing a full page reload; everything else opens in a
// new tab. A task link additionally opens the Tasks app in the split pane
// (focused on that task) rather than navigating away from chat, when a Layout
// split-control provider is present. Plain text without URLs falls through
// unchanged.
const URL_RE = /(https?:\/\/[^\s]+)/g;

// URLs often sit next to punctuation ("see https://x.com."). Peel trailing
// characters that are almost never part of the link back into plain text so the
// anchor doesn't swallow them.
function splitTrailing(url: string): [string, string] {
  const m = url.match(/[),.;:!?]+$/);
  if (!m) return [url, ""];
  return [url.slice(0, -m[0].length), m[0]];
}

// A same-origin `/tasks?task=<id>` link → the numeric task id, else null.
function taskIdFromUrl(u: URL): number | null {
  if (u.pathname !== "/tasks") return null;
  const raw = u.searchParams.get("task");
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

export default function MessageText({ text }: { text: string }) {
  const { openApp } = useSplitControl();
  // String.split with a capturing group interleaves plain text (even indices)
  // and the captured URLs (odd indices).
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const [url, trailing] = splitTrailing(part);
        let internal: string | null = null;
        let taskId: number | null = null;
        try {
          const u = new URL(url);
          if (u.origin === window.location.origin) {
            internal = u.pathname + u.search + u.hash;
            taskId = taskIdFromUrl(u);
          }
        } catch {
          // Unparseable — fall through and render as a plain external anchor.
        }
        return (
          <span key={i}>
            {internal ? (
              <Link
                className="message-link"
                to={internal}
                // A task link opens the Tasks split pane on that task instead of
                // navigating away from chat. Falls back to plain navigation when
                // no split-control provider is present (openApp null).
                onClick={
                  taskId != null && openApp
                    ? (e) => {
                        e.preventDefault();
                        openApp("tasks", { taskId });
                      }
                    : undefined
                }
              >
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
