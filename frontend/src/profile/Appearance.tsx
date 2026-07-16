import SettingsShell from "./SettingsShell";
import ThemeCustomizer from "../theme/ThemeCustomizer";

// A full page for the theme customizer, so Appearance navigates like My
// Profile / Integrations instead of expanding inline inside the sidebar.
export default function Appearance() {
  return (
    <SettingsShell title="Appearance">
      <section className="settings-card">
        <h2 className="settings-card-title">Theme</h2>
        <ThemeCustomizer />
      </section>
    </SettingsShell>
  );
}
