import { useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { isHtmlBody } from "./bodyUtils";
import { renderEmailBody } from "./renderUtils";

// Links inside a sanitized email open in a new tab and can never reach back
// into the opener window. Registered once at module load.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Injected into the iframe document so emails relying on UA defaults still read
// well and images/tables can't overflow. HTML emails are authored against a
// WHITE canvas (they hardcode dark text but rarely set a page background), so
// the frame always renders on white with dark defaults — deliberately
// independent of the app theme. A themed background here put near-black email
// text on a navy canvas and made messages unreadable; white keeps every email
// legible in every theme. Emails that hardcode their own colors keep them.
const FRAME_CSS = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1f2937;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #2563eb; }
`;

// Nearest scrollable ancestor of the iframe in the PARENT document (the reading
// pane). Used to forward wheel/touchpad scroll out of the content-sized frame.
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// SECURITY: the HTML is sanitized with DOMPurify *and* the frame runs without
// `allow-scripts`, so email JavaScript can never execute. `allow-same-origin`
// exists only to measure content height for auto-fit; absent `allow-scripts` it
// grants the email no real capability. Do not weaken either layer.
function HtmlEmail({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);

  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      // Keep formatting + inline styles + <style> (safe inside the sandbox);
      // drop anything active or interactive.
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "textarea",
        "select",
      ],
      ADD_ATTR: ["target"],
    });
    return (
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      // No Referer on any subresource: some image CDNs (e.g. Google's
      // lh3.googleusercontent.com avatars) reject requests carrying a
      // third-party referrer (429), and not leaking our origin to email
      // image hosts is standard mail-client privacy behaviour anyway.
      `<meta name="referrer" content="no-referrer">` +
      `<base target="_blank"><style>${FRAME_CSS}</style></head>` +
      `<body>${clean}</body></html>`
    );
  }, [html]);

  // Size the iframe to its content. Re-run as late-loading images arrive so the
  // frame grows to fit instead of clipping or leaving a gap.
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (!doc?.documentElement) return;
    const next = doc.documentElement.scrollHeight;
    if (next > 0) setHeight((prev) => (prev === next ? prev : next));
  };

  const handleLoad = () => {
    fit();
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("img").forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", fit, { once: true });
        img.addEventListener("error", fit, { once: true });
      }
    });

    // The iframe is sized to its full content, so it can't scroll itself, and a
    // same-origin content-sized frame doesn't reliably chain wheel/touchpad
    // scroll to the parent. Forward wheel deltas to the reading pane so scrolling
    // with the pointer over the email body moves the pane. Re-bound on every
    // load; changing srcDoc discards the old document (and its listener).
    if (frame) {
      const scroller = scrollableAncestor(frame);
      if (scroller) {
        doc.addEventListener(
          "wheel",
          (event) => {
            const factor =
              event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                  ? scroller.clientHeight
                  : 1;
            scroller.scrollTop += event.deltaY * factor;
            scroller.scrollLeft += event.deltaX * factor;
            event.preventDefault();
          },
          { passive: false }
        );
      }
    }
  };

  return (
    <iframe
      ref={ref}
      title="Email content"
      className="email-html-frame"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={handleLoad}
      style={{ width: "100%", border: "none", height }}
    />
  );
}

export default function EmailBody({ body }: { body: string }) {
  if (isHtmlBody(body)) {
    return <HtmlEmail html={body} />;
  }
  return <>{renderEmailBody(body)}</>;
}
