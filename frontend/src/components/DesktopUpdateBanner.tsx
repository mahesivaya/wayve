import { useEffect, useState } from "react";

import {
  isDesktopApp,
  MAC_ARM64_DOWNLOAD,
  MAC_X64_DOWNLOAD,
  SELF_UPDATING_BUILD_PUBLISHED,
} from "../utils/desktop";
import "./DesktopUpdateBanner.css";

// "Later" lasts until the app next starts, when a ready update has installed
// anyway. Storage can throw in a locked-down webview; the banner just returns.
const HIDDEN_KEY = "fluxze:update-banner-hidden";

function wasHidden(id: string): boolean {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === id;
  } catch {
    return false;
  }
}

function rememberHidden(id: string): void {
  try {
    sessionStorage.setItem(HIDDEN_KEY, id);
  } catch {
    // Still hidden until the next page load.
  }
}

// Tells a desktop user that a newer app is ready. Renders nothing in a browser.
export default function DesktopUpdateBanner() {
  const update = window.fluxzeDesktop?.update;
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    if (!update) return;
    let active = true;
    void update.getReadyVersion().then((version) => {
      if (active && version) setReadyVersion(version);
    });
    const unsubscribe = update.onReady(setReadyVersion);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [update]);

  // An older install can't update itself, so it has to download this once.
  const mustDownload =
    isDesktopApp() && !update && SELF_UPDATING_BUILD_PUBLISHED;
  const id = readyVersion ?? (mustDownload ? "download" : null);
  if (!id || hidden === id || wasHidden(id)) return null;

  const later = () => {
    rememberHidden(id);
    setHidden(id);
  };

  return (
    <aside className="desktop-update" role="status">
      <p className="desktop-update-title">
        {readyVersion ? "Update ready" : "Update available"}
      </p>
      <p className="desktop-update-text">
        {readyVersion
          ? "A new version of Fluxze is ready to install."
          : "Download the latest Fluxze once, and it will keep itself up to date from then on."}
      </p>
      <div className="desktop-update-actions">
        {readyVersion ? (
          <button
            type="button"
            className="desktop-update-primary"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              void update?.install();
            }}
          >
            {restarting ? "Restarting…" : "Restart to update"}
          </button>
        ) : (
          <>
            <a className="desktop-update-primary" href={MAC_ARM64_DOWNLOAD}>
              Apple Silicon
            </a>
            <a className="desktop-update-primary" href={MAC_X64_DOWNLOAD}>
              Intel
            </a>
          </>
        )}
        <button
          type="button"
          className="desktop-update-later"
          disabled={restarting}
          onClick={later}
        >
          Later
        </button>
      </div>
    </aside>
  );
}
