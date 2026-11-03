import type { ReactNode } from "react";
import {
  CodeFileIcon,
  ConfigFileIcon,
  DataFileIcon,
  DockerFileIcon,
  FileIcon,
  ImageFileIcon,
  LockFileIcon,
  MarkupFileIcon,
  ReactFileIcon,
  RustFileIcon,
  ShellFileIcon,
  SqlFileIcon,
  StyleFileIcon,
  TextFileIcon,
} from "../icons";

// The sign beside a filename in a diff header, picked from its extension. The
// colours are mid-tones so they read on both the light and dark themes.
type FileKind = { label: string; icon: ReactNode; color: string };

const SIZE = 14;

const kind = (label: string, icon: ReactNode, color: string): FileKind => ({
  label,
  icon,
  color,
});

const code = (label: string, color: string) =>
  kind(label, <CodeFileIcon size={SIZE} />, color);
const config = (label: string) =>
  kind(label, <ConfigFileIcon size={SIZE} />, "#7c8a9a");
const image = kind("Image", <ImageFileIcon size={SIZE} />, "#a855f7");
const shell = kind("Shell script", <ShellFileIcon size={SIZE} />, "#4d9a4d");
const markdown = kind("Markdown", <TextFileIcon size={SIZE} />, "#5b8def");
const style = kind("Stylesheet", <StyleFileIcon size={SIZE} />, "#d6549a");
const lockFile = kind("Lock file", <LockFileIcon size={SIZE} />, "#7c8a9a");
const docker = kind("Dockerfile", <DockerFileIcon size={SIZE} />, "#2496ed");
const fallback = kind("File", <FileIcon size={SIZE} />, "#7c8a9a");

const BY_EXTENSION: Record<string, FileKind> = {
  tsx: kind("TypeScript React", <ReactFileIcon size={SIZE} />, "#14a3c7"),
  jsx: kind("JavaScript React", <ReactFileIcon size={SIZE} />, "#14a3c7"),
  ts: code("TypeScript", "#3178c6"),
  js: code("JavaScript", "#c9a227"),
  mjs: code("JavaScript", "#c9a227"),
  cjs: code("JavaScript", "#c9a227"),
  rs: kind("Rust", <RustFileIcon size={SIZE} />, "#ce6a35"),
  py: code("Python", "#3f8fc4"),
  go: code("Go", "#00a7d0"),
  java: code("Java", "#d0672f"),
  rb: code("Ruby", "#c2413a"),
  php: code("PHP", "#7a86b8"),
  c: code("C", "#5c7fa8"),
  h: code("C header", "#5c7fa8"),
  cpp: code("C++", "#5c7fa8"),
  json: kind("JSON", <DataFileIcon size={SIZE} />, "#c9a227"),
  css: style,
  scss: style,
  html: kind("HTML", <MarkupFileIcon size={SIZE} />, "#e0653a"),
  xml: kind("XML", <MarkupFileIcon size={SIZE} />, "#e0653a"),
  md: markdown,
  mdx: markdown,
  txt: kind("Text", <TextFileIcon size={SIZE} />, "#7c8a9a"),
  sql: kind("SQL", <SqlFileIcon size={SIZE} />, "#c7853a"),
  sh: shell,
  bash: shell,
  zsh: shell,
  yml: config("YAML"),
  yaml: config("YAML"),
  toml: config("TOML"),
  ini: config("Config"),
  env: config("Environment"),
  conf: config("Config"),
  lock: lockFile,
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  webp: image,
  svg: image,
  ico: image,
};

// Names that say more than their extension, or have none.
function fileKind(path: string): FileKind {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return docker;
  if (name === "justfile" || name === "makefile") return shell;
  if (name === "package-lock.json") return lockFile;
  if (name === ".env" || name.startsWith(".env.")) return config("Environment");
  const dot = name.lastIndexOf(".");
  if (dot === -1) return fallback;
  // hasOwn: a file called `a.constructor` must not find Object.prototype's.
  const extension = name.slice(dot + 1);
  return Object.hasOwn(BY_EXTENSION, extension)
    ? BY_EXTENSION[extension]
    : fallback;
}

export function FileTypeIcon({ path }: { path: string }) {
  const { label, icon, color } = fileKind(path);
  return (
    <span
      className="github-file-type"
      role="img"
      aria-label={label}
      title={label}
      style={{ color }}
    >
      {icon}
    </span>
  );
}
