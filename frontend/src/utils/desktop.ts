import { getApiBase } from "../config/env";

// Detect whether the web app is running inside the Fluxze desktop (Electron)
// shell. The desktop preload bridge exposes `window.fluxzeDesktop`
// (see desktop/preload.cjs); the plain browser app has no such object.

declare global {
  interface Window {
    fluxzeDesktop?: {
      isDesktop?: boolean;
      version?: string;
      platform?: string;
      // This shell hides the native title bar and floats the window controls
      // over the page. Absent on older installs.
      titleBarInset?: boolean;
      // Absent on installs from before the shell could update itself.
      update?: {
        // The version downloaded and waiting for a restart, if any.
        getReadyVersion: () => Promise<string | null>;
        // Returns the unsubscribe function.
        onReady: (listener: (version: string) => void) => () => void;
        install: () => Promise<void>;
      };
      // "Remember password on this Mac". The shell keeps it encrypted with a
      // Keychain key. Absent on installs from before 1.0.1.
      savedLogin?: {
        get: () => Promise<SavedLogin | null>;
        // Resolves false when the Mac couldn't encrypt it.
        save: (email: string, password: string) => Promise<boolean>;
        clear: () => Promise<void>;
      };
    };
  }
}

export type SavedLogin = { email: string; password: string };

// The desktop shell's saved-login store, or null in a browser or an older shell.
export function desktopSavedLogin() {
  return isDesktopApp() ? (window.fluxzeDesktop?.savedLogin ?? null) : null;
}

// Installers are hosted on S3. The original Fluxze-arm64/x64.dmg objects are
// write-locked, so current builds publish under these keys instead.
const DOWNLOADS = "https://fluxze-desktop-downloads.s3.us-east-1.amazonaws.com";
export const MAC_ARM64_DOWNLOAD = `${DOWNLOADS}/Fluxze-mac-arm64.dmg`;
export const MAC_X64_DOWNLOAD = `${DOWNLOADS}/Fluxze-mac-x64.dmg`;

// The site's Download App menu goes through the backend, which counts the
// download (for platform Analytics) and redirects to the installer above, or
// to the App Store listing for "ios".
export type DesktopBuild = "mac-arm64" | "mac-x64";
export type TrackedBuild = DesktopBuild | "ios";
export function trackedDownloadUrl(build: TrackedBuild): string {
  return `${getApiBase()}/api/desktop/download/${build}`;
}

// Whether the download above is a build that can update itself. Older installs
// are prompted to get it once, so flip this only after publishing that build, or
// the prompt sends them to the installer they already have.
export const SELF_UPDATING_BUILD_PUBLISHED = false;

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
  const inset = desktop && window.fluxzeDesktop?.titleBarInset === true;
  root.classList.toggle("is-titlebar-inset", inset);
  // Every page, including those without the app header, needs something to drag
  // the window by. First in <body> so the app's no-drag controls override it.
  if (inset && !document.querySelector(".desktop-drag-strip")) {
    const strip = document.createElement("div");
    strip.className = "desktop-drag-strip";
    document.body.prepend(strip);
  }
}
