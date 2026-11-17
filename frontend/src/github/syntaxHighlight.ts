import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";

// lowlight's common set (about 37 languages: the web, systems and scripting
// staples, Swift, Kotlin, Ruby, PHP, C#, ...) plus a few config formats repos
// are full of.
const lowlight = createLowlight({
  ...common,
  dockerfile,
  nginx,
  properties,
  protobuf,
});

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  cfg: "ini",
  conf: "ini",
  cs: "csharp",
  diff: "diff",
  env: "properties",
  gql: "graphql",
  graphql: "graphql",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lock: "ini",
  lua: "lua",
  m: "objectivec",
  patch: "diff",
  php: "php",
  pl: "perl",
  properties: "properties",
  proto: "protobuf",
  r: "r",
  rb: "ruby",
  svelte: "xml",
  swift: "swift",
  txt: "plaintext",
  vue: "xml",
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
  ".dockerignore": "bash",
  ".gitattributes": "bash",
  ".gitignore": "bash",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  justfile: "makefile",
  makefile: "makefile",
  rakefile: "ruby",
};

// Null for a file type with no grammar here; tokenizeLines then guesses.
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
  // .env, .env.local, .env.example: KEY=value lines.
  if (name === ".env" || name.startsWith(".env.")) return "properties";
  if (name.startsWith("dockerfile.")) return "dockerfile";
  if (name.includes("nginx") && name.endsWith(".conf")) return "nginx";
  return dot > 0 ? (LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
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
// Guessing tries every grammar, so it's kept to smaller files, and a guess is
// used only when the code clearly reads as that language.
const MAX_AUTO_CHARS = 50_000;
const MIN_AUTO_RELEVANCE = 8;

type HighlightTree = { children: unknown[]; data?: { relevance?: number } };

function highlight(
  code: string,
  language: string | null
): HighlightTree | null {
  if (language) return lowlight.highlight(language, code) as HighlightTree;
  if (code.length > MAX_AUTO_CHARS) return null;
  const guess = lowlight.highlightAuto(code) as HighlightTree;
  return (guess.data?.relevance ?? 0) >= MIN_AUTO_RELEVANCE ? guess : null;
}

// Colours a run of consecutive lines, one token list per line. They go through
// together so a block comment or multi-line string keeps its colour on every
// line. With no known language the grammar is guessed. Null when nothing fits
// or the code is too large.
export function tokenizeLines(
  lines: string[],
  language: string | null
): CodeToken[][] | null {
  const code = lines.join("\n");
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const tree = highlight(code, language);
  if (!tree) return null;

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
  walk(tree.children as HastNode[]);
  return out;
}
