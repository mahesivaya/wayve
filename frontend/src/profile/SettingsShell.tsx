import { type ReactNode } from "react";

import "./profile.css";

import { useIsNarrow } from "../components/useIsNarrow";

// Shared scaffolding for the settings-family pages (Settings, My Profile,
// Integrations, …): the page title over the page's own cards. On wide screens
// the settings menu is in the app's main sidebar (Layout), so the app's frame
// stays the same; narrow screens get the plain single-column stack.
export default function SettingsShell({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  // Must agree with Layout's `settingsTakeover`, which shows the settings menu
  // in the main sidebar exactly when this drops its own.
  const narrow = useIsNarrow();

  // Narrow: the plain centered stack, with the main sidebar still in place.
  if (narrow) {
    return (
      <div className="settings-page">
        <div className="settings-stack">
          <h1 className="settings-page-title">{title}</h1>
          {children}
        </div>
      </div>
    );
  }

  // Wide: the settings menu lives in the app's own sidebar (Layout swaps its
  // menu on settings routes), so this is just the content pane.
  return (
    <div className="settings-page settings-page--split">
      <div className="settings-content">
        <div className="settings-stack">
          <h1 className="settings-page-title">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}
