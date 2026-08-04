import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts for a pane, Gmail-style: `{ r: reply, f: forward }`.
 *
 * Bindings are written as an optional modifier prefix plus the key the browser
 * reports: `"r"`, `"escape"`, `"mod+enter"` (mod = Cmd on macOS, Ctrl
 * elsewhere), `"alt+ArrowDown"`. For a key that needs Shift, write the
 * character it produces (`"#"`, not `"shift+3"`) — Shift is only a modifier for
 * non-printable keys such as `"shift+tab"`.
 *
 * Plain single-key bindings never fire while the user is typing in an input,
 * textarea, or contenteditable; modifier combos still do, so a composer can
 * bind `mod+enter` to send. `escape` is exempt from that rule (see
 * ALWAYS_ACTIVE) because dismissing a composer from inside it is the point.
 *
 * A keypress a closer listener already claimed (`defaultPrevented`) is ignored,
 * so a popup that handles its own Escape doesn't also trigger the pane binding.
 *
 * Known limitation: `"+"` itself cannot be bound, since it is the separator.
 */
export type ShortcutMap = Record<string, (event: KeyboardEvent) => void>;

// Keys that are never text input, so they stay live inside a focused field.
const ALWAYS_ACTIVE = new Set(["escape"]);

export function useShortcuts(map: ShortcutMap, enabled = true): void {
  // The map is rebuilt every render (its handlers close over current state), so
  // it lives in a ref and the listener below stays mounted across renders.
  const mapRef = useRef<ShortcutMap>(map);
  useEffect(() => {
    mapRef.current = map;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      // A closer listener already claimed this key. React 18 attaches its
      // handlers at the root container — a descendant of document — so they run
      // first and a popup's own Escape handling lands here as defaultPrevented.
      if (event.defaultPrevented) return;
      const combo = comboFor(event);
      const handler = lookup(mapRef.current, combo);
      if (!handler) return;
      // Never steal a bare keystroke from a field the user is typing in.
      if (
        !combo.includes("+") &&
        !ALWAYS_ACTIVE.has(combo) &&
        isEditable(event.target)
      ) {
        return;
      }
      event.preventDefault();
      handler(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

function lookup(map: ShortcutMap, combo: string) {
  for (const [binding, handler] of Object.entries(map)) {
    if (normalize(binding) === combo) return handler;
  }
  return undefined;
}

/** Canonical form of a declared binding, e.g. `"Cmd+Enter"` -> `"mod+enter"`. */
function normalize(binding: string): string {
  const parts = binding
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set(
    parts.map((mod) =>
      mod === "cmd" || mod === "ctrl" || mod === "meta" ? "mod" : mod
    )
  );
  return buildCombo(mods.has("mod"), mods.has("alt"), mods.has("shift"), key);
}

/** Canonical form of an actual keypress, using the same rules as `normalize`. */
function comboFor(event: KeyboardEvent): string {
  return buildCombo(
    event.metaKey || event.ctrlKey,
    event.altKey,
    event.shiftKey,
    event.key.toLowerCase()
  );
}

function buildCombo(
  mod: boolean,
  alt: boolean,
  shift: boolean,
  key: string
): string {
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (alt) parts.push("alt");
  // A printable character already encodes Shift ("#" rather than "shift+3"),
  // so only named keys carry it as a modifier.
  if (shift && key.length > 1) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

// Duck-typed rather than `instanceof HTMLElement`: an element from the email
// body's same-origin iframe belongs to that frame's realm, so it fails an
// `instanceof` against this window's constructor and slips past the guard.
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.isContentEditable === true ||
    /^(input|textarea|select)$/i.test(el.tagName)
  );
}
