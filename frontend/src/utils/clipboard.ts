// Copies text to the clipboard, resolving true on success and false otherwise.
//
// Tries the async Clipboard API first. It can be missing (insecure context) or
// refused: the desktop shell only grants "clipboard-read", so Electron denies
// the "clipboard-sanitized-write" permission writeText needs. The fallback is
// the classic hidden-textarea + execCommand("copy"), which runs inside the click
// that called it and needs no permission. Callers show their own feedback, so a
// failure never passes silently.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused or unavailable: try the fallback below.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-screen but still selectable; `display: none` would block selection.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const previousFocus = document.activeElement as HTMLElement | null;
  try {
    area.focus();
    area.select();
    // Deprecated, but still the one copy path that needs no permission.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    previousFocus?.focus?.();
  }
}
