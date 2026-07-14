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
// well and images/tables can't overflow. Only defaults are set, tuned for the
// navy app theme; emails that hardcode their own colors keep them.
const FRAME_CSS = `
  html, body { margin: 0; padding: 0; background: #0a1730; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #c6d2ec;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img, video { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #60a5fa; }
`;

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
    const doc = ref.current?.contentDocument;
    doc?.querySelectorAll("img").forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", fit, { once: true });
        img.addEventListener("error", fit, { once: true });
      }
    });
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
