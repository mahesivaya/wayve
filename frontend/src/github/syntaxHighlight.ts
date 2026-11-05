import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  makefile,
  markdown,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
});

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  cts: "typescript",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

// Null for anything without a grammar here, which then shows as plain text.
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return (
    LANGUAGE_BY_NAME[name] ??
    LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ??
    (name.startsWith("dockerfile.") ? "dockerfile" : null)
  );
}

export type CodeToken = { text: string; className?: string };

type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

// Past this a file stays plain, so a generated bundle can't freeze the tab.
const MAX_HIGHLIGHT_CHARS = 200_000;

// Colours a run of consecutive lines, one token list per line. They go through
// together so a block comment or multi-line string keeps its colour on every
// line. Null when there's no grammar or the code is too large.
export function tokenizeLines(
  lines: string[],
  language: string | null
): CodeToken[][] | null {
  if (!language) return null;
  const code = lines.join("\n");
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;

  const out: CodeToken[][] = [[]];
  const walk = (nodes: HastNode[], inherited?: string) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const [first = "", ...rest] = (node.value ?? "").split("\n");
        if (first)
          out[out.length - 1].push({ text: first, className: inherited });
        for (const part of rest) {
          out.push(part ? [{ text: part, className: inherited }] : []);
        }
      } else if (node.children) {
        const own = node.properties?.className;
        walk(node.children, Array.isArray(own) ? own.join(" ") : inherited);
      }
    }
  };
  walk(lowlight.highlight(language, code).children as HastNode[]);
  return out;
}
