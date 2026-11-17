// The per-type sign beside a file (file browser and commit file lists), and
// syntax colours for the same languages in the preview.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { FileTypeIcon } from "../../github/FileTypeIcon";
import { CodeFile } from "../../github/CodeFile";

afterEach(cleanup);

const SAMPLES: [path: string, label: string, code: string][] = [
  [
    "ios/App.swift",
    "Swift",
    'import SwiftUI\nstruct A: View { var body: some View { Text("hi") } }',
  ],
  ["app/Main.kt", "Kotlin", 'fun main() {\n  val x = "hi"\n  println(x)\n}'],
  ["build.gradle.kts", "Kotlin", 'plugins { kotlin("jvm") version "2.0" }'],
  [
    "src/Program.cs",
    "C#",
    'class Program {\n  static void Main() { var s = "hi"; }\n}',
  ],
];

describe("FileTypeIcon", () => {
  it.each(SAMPLES)("labels %s as %s", (path, label) => {
    render(<FileTypeIcon path={path} />);
    expect(screen.getByRole("img", { name: label })).toBeTruthy();
  });

  it("falls back to a plain file for unknown types", () => {
    render(<FileTypeIcon path="notes.xyz" />);
    expect(screen.getByRole("img", { name: "File" })).toBeTruthy();
  });
});

describe("syntax colours", () => {
  it.each(SAMPLES)("colours %s", (path, _label, code) => {
    const { container } = render(<CodeFile path={path} text={code} />);
    expect(container.querySelector(".hljs-keyword, .hljs-string")).toBeTruthy();
  });
});
