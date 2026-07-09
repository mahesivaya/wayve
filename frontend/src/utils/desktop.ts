// Detect whether the web app is running inside the Fluxze desktop (Electron)
// shell. The desktop preload bridge exposes `window.fluxzeDesktop`
// (see desktop/preload.cjs); the plain browser app has no such object.

declare global {
  interface Window {
    fluxzeDesktop?: {
      isDesktop?: boolean;
      version?: string;
      platform?: string;
    };
  }
}

export function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" && window.fluxzeDesktop?.isDesktop === true
  );
}

// Stamp the root <html> element once at startup so CSS can fork on the runtime
// without any per-component JS. In the desktop shell this adds the `is-desktop`
// class and a `data-platform` (darwin|win32|linux); the plain browser gets
// `is-web`. Scope desktop-only rules as `.is-desktop .foo { … }` (and web-only
// as `.is-web .foo { … }`) in any stylesheet.
export function applyRuntimeClass(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const desktop = isDesktopApp();
  root.classList.toggle("is-desktop", desktop);
  root.classList.toggle("is-web", !desktop);
  if (desktop && window.fluxzeDesktop?.platform) {
    root.dataset.platform = window.fluxzeDesktop.platform;
  }
}
