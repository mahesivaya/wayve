// Pure helpers for the AI-fix panel. They live apart from AiFixPanel.tsx so that
// file only exports its component (React Fast Refresh requires that).

// Classify one unified-diff line for colouring. Order matters: the +++/---
// file headers must be caught before the +/- added/removed lines.
export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "is-meta";
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "is-meta";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return "";
}

// The wire format is base64 so arbitrary bytes survive JSON, but the editor
// works in text. btoa/atob are latin1-only, so round-trip through UTF-8 bytes —
// otherwise any non-ASCII character in a source file corrupts on save.
export function decodeContent(b64: string): string {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}
