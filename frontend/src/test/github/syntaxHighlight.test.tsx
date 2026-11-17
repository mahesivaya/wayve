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

  it("knows the config files and languages repos are full of", () => {
    expect(languageFor("infra/nginx/nginx.conf")).toBe("nginx");
    expect(languageFor("infra/justfile")).toBe("makefile");
    expect(languageFor(".env.example")).toBe("properties");
    expect(languageFor(".gitignore")).toBe("bash");
    expect(languageFor("Cargo.lock")).toBe("ini");
    expect(languageFor("ios/App.swift")).toBe("swift");
    expect(languageFor("app/models/user.rb")).toBe("ruby");
    expect(languageFor("index.php")).toBe("php");
    expect(languageFor("Main.kt")).toBe("kotlin");
    expect(languageFor("Program.cs")).toBe("csharp");
  });

  it("has no grammar for unknown names", () => {
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

  it("stays plain for prose, plain text or a huge file", () => {
    expect(tokenizeLines(["Copyright the authors."], null)).toBeNull();
    expect(tokenizeLines(["const a = 1;"], "plaintext")?.flat()).toEqual([
      { text: "const a = 1;", className: undefined },
    ]);
    expect(tokenizeLines(["a".repeat(200_001)], "rust")).toBeNull();
  });

  it("guesses the language of a file it doesn't recognise", () => {
    const tokens = tokenizeLines(
      [
        "#!/usr/bin/env python3",
        "import os",
        "",
        "def main():",
        '    """Entry point."""',
        "    return os.getcwd()",
      ],
      null
    );
    expect(tokens?.flat().some((t) => t.className?.includes("hljs"))).toBe(
      true
    );
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
