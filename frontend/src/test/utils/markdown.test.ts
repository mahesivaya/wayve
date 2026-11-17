// renderUntrustedMarkdown: a README from any repository becomes safe HTML.
// `marked` itself is a script loaded at runtime, so these tests hand it a
// stand-in parser that returns the HTML under test.
import { describe, expect, it } from "vitest";
import { renderUntrustedMarkdown } from "../../utils/markdown";

const render = (html: string, opts = {}) =>
  renderUntrustedMarkdown(() => html, "ignored", opts);

describe("renderUntrustedMarkdown", () => {
  it("strips scripts, event handlers and javascript: links", () => {
    const out = render(
      '<p onclick="steal()">hi</p><script>steal()</script>' +
        '<a href="javascript:steal()">x</a><img src="x.png" onerror="steal()">'
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(out).toContain("<p>hi</p>");
  });

  it("opens links in a new tab that can't reach back", () => {
    const out = render('<a href="https://example.com">site</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("resolves relative links and images against the repository", () => {
    const out = render(
      '<a href="docs/setup.md">setup</a><img src="./img/logo.png">' +
        '<a href="#install">install</a>',
      {
        linkBase: "https://github.com/acme/api/blob/main/",
        imageBase: "https://raw.githubusercontent.com/acme/api/main/",
      }
    );
    expect(out).toContain(
      'href="https://github.com/acme/api/blob/main/docs/setup.md"'
    );
    expect(out).toContain(
      'src="https://raw.githubusercontent.com/acme/api/main/img/logo.png"'
    );
    // In-page anchors stay as they are.
    expect(out).toContain('href="#install"');
  });
});
