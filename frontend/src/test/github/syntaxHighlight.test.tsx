// Syntax colours in the file preview and the diffs: they never change the text,
// and search matches still land on the right characters.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { CodeFile } from "../../github/CodeFile";
import { CommitPatch } from "../../github/commitDiff";
import { languageFor, tokenizeLines } from "../../github/syntaxHighlight";

afterEach(cleanup);

describe("languageFor", () => {
  it("picks a grammar from the file name", () => {
    expect(languageFor("backend/src/pool.rs")).toBe("rust");
    expect(languageFor("src/App.tsx")).toBe("typescript");
    expect(languageFor("infra/Dockerfile")).toBe("dockerfile");
    expect(languageFor("infra/Dockerfile.dev")).toBe("dockerfile");
  });

  it("leaves unknown files plain", () => {
    expect(languageFor("notes.xyz")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
  });
});

describe("tokenizeLines", () => {
  it("keeps every line's text exactly", () => {
    const lines = ["fn main() {", "", '    let a = "x";', "}"];
    const tokens = tokenizeLines(lines, "rust");
    expect(tokens?.map((line) => line.map((t) => t.text).join(""))).toEqual(
      lines
    );
  });

  it("carries a block comment's colour across its lines", () => {
    const tokens = tokenizeLines(["/* one", "two */", "let a = 1;"], "rust");
    expect(tokens?.[1][0].className).toContain("hljs-comment");
    expect(tokens?.[2][0].className).toContain("hljs-keyword");
  });

  it("stays plain without a grammar or for a huge file", () => {
    expect(tokenizeLines(["a"], null)).toBeNull();
    expect(tokenizeLines(["a".repeat(200_001)], "rust")).toBeNull();
  });
});

describe("the file preview", () => {
  it("numbers the lines and colours the code", () => {
    const { container } = render(
      <CodeFile path="pool.rs" text={"use std::fmt;\n\nfn main() {}\n"} />
    );
    const numbers = Array.from(
      container.querySelectorAll(".github-code-file-no")
    );
    expect(numbers.map((n) => n.textContent)).toEqual(["1", "2", "3"]);
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("use");
  });

  it("says so when there's nothing to show", () => {
    const { container } = render(<CodeFile path="pool.rs" text="" />);
    expect(container.textContent).toBe("No preview available.");
  });
});

describe("a colored diff", () => {
  const PATCH =
    "@@ -1,2 +1,2 @@\n fn keep() {}\n-fn old() {}\n+pub fn new() {}";

  it("colours both sides from the file name", () => {
    const { container } = render(<CommitPatch patch={PATCH} filename="a.rs" />);
    const keywords = Array.from(
      container.querySelectorAll(".hljs-keyword")
    ).map((el) => el.textContent);
    expect(keywords).toContain("pub");
    expect(container.querySelector(".is-del")?.textContent).toBe("fn old() {}");
    expect(container.querySelector(".is-add")?.textContent).toBe(
      "pub fn new() {}"
    );
  });

  it("stays plain without a file name", () => {
    const { container } = render(<CommitPatch patch={PATCH} />);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });

  it("marks a search match that runs across colours as one match", () => {
    const { container } = render(
      <CommitPatch patch={PATCH} filename="a.rs" query="pub fn" />
    );
    const marks = container.querySelectorAll(".github-code-match");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("pub fn");
  });
});
