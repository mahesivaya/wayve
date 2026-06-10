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
