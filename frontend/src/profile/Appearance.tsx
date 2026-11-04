import { useState } from "react";

import SettingsShell from "./SettingsShell";
import ThemeCustomizer from "../theme/ThemeCustomizer";
import ThemeModePicker from "../theme/ThemeModePicker";

// A full page for the theme customizer, so Appearance navigates like My
// Profile / Integrations instead of expanding inline inside the sidebar.
export default function Appearance() {
  // The editor seeds its sliders once, so a pick up here restarts it from the new
  // choice rather than leaving it to preview the old one.
  const [editorKey, setEditorKey] = useState(0);

  return (
    <SettingsShell title="Appearance">
      <section className="settings-card">
        <h2 className="settings-card-title">Color theme</h2>
        <ThemeModePicker onPick={() => setEditorKey((key) => key + 1)} />
      </section>
      <section className="settings-card">
        <h2 className="settings-card-title">Theme</h2>
        <ThemeCustomizer key={editorKey} />
      </section>
    </SettingsShell>
  );
}
