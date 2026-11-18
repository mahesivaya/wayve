import DOMPurify from "dompurify";

// Markdown → HTML with `marked`, self-hosted in frontend/public/marked.min.js
// (no CDN allowance in the production CSP) and loaded once on first use. Shared
// by the public Docs page and Code Repo's README.

const MARKED_SCRIPT = "/marked.min.js";

type MarkedFn = (md: string) => string;

interface MarkedGlobal {
  parse: MarkedFn;
}

function getMarkedFromWindow(): MarkedGlobal | undefined {
  return (window as unknown as { marked?: MarkedGlobal }).marked;
}

export async function loadMarked(): Promise<MarkedFn> {
  const already = getMarkedFromWindow();
  if (already) return (md: string) => already.parse(md);
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${MARKED_SCRIPT}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("marked load failed")),
        { once: true }
      );
      return;
    }
    const tag = document.createElement("script");
    tag.src = MARKED_SCRIPT;
    tag.async = true;
    tag.addEventListener("load", () => resolve(), { once: true });
    tag.addEventListener(
      "error",
      () => reject(new Error("marked load failed")),
      { once: true }
    );
    document.body.appendChild(tag);
  });
  const loaded = getMarkedFromWindow();
  if (!loaded) {
    throw new Error("marked bundle loaded but global missing");
  }
  return (md: string) => loaded.parse(md);
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const resolve = (url: string, base: string | undefined): string => {
  if (!base || ABSOLUTE.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
};

export interface UntrustedMarkdownOptions {
  // Where relative links point (a README's `docs/setup.md`), e.g. the repo's
  // GitHub tree URL with a trailing slash.
  linkBase?: string;
  // Where relative images load from, e.g. the repo's raw-content URL.
  imageBase?: string;
  // false drops images altogether, for text whose author could use an image
  // URL to send data out (it loads with no click).
  images?: boolean;
}

// Renders Markdown someone else wrote (a repository's README) to HTML that is
// safe to inject: sanitized with DOMPurify, relative links and images resolved
// against the given bases, and every link opening in a new tab that can't
// reach back into this window.
export function renderUntrustedMarkdown(
  parse: MarkedFn,
  markdown: string,
  { linkBase, imageBase, images = true }: UntrustedMarkdownOptions = {}
): string {
  const clean = DOMPurify.sanitize(parse(markdown), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      ...(images ? [] : ["img", "picture", "svg", "video", "audio"]),
    ],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    a.setAttribute("href", resolve(href, linkBase));
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  doc.querySelectorAll("img[src]").forEach((img) => {
    img.setAttribute("src", resolve(img.getAttribute("src") ?? "", imageBase));
    img.setAttribute("loading", "lazy");
  });
  return doc.body.innerHTML;
}
