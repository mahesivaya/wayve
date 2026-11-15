/** Focus is somewhere the user types, where arrow keys move the caret and
 *  modifier presses may be part of typing (e.g. AltGr = Ctrl+Alt on Windows). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
      el.getAttribute?.("role") === "textbox")
  );
}
