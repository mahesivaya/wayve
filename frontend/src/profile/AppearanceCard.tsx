import { useNavigate } from "react-router-dom";

import { BW_DARK_INPUT } from "../theme/blackAndWhite";
import { basicThemeMode } from "../theme/basicThemeMode";
import { useCustomTheme } from "../theme/useCustomTheme";

type ThemeMode = "system" | "light" | "dark" | "custom";

// The Appearance entry on the General settings page (narrow screens, which
// have no settings rail): one tap for Light or Dark, and Custom opens the full
// theme editor to create or pick other themes.
export default function AppearanceCard() {
  const navigate = useNavigate();
  const { choice, ui, setChoice, resetToDefault, resetUi } = useCustomTheme();

  const current: ThemeMode = basicThemeMode(choice, ui) ?? "custom";

  const option = (
    mode: ThemeMode,
    icon: string,
    label: string,
    onClick: () => void
  ) => (
    <button
      type="button"
      className={`settings-theme-mode${current === mode ? " active" : ""}`}
      aria-pressed={current === mode}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );

  return (
    <section className="settings-card">
      <h2 className="settings-card-title">Appearance</h2>
      <div className="settings-theme-modes" role="group" aria-label="Theme">
        {/* Resetting keeps the saved theme library; it only clears the active
            palette and overrides. */}
        {option("system", "💻", "System", () => {
          setChoice({ kind: "system" });
          resetUi();
        })}
        {option("light", "☀️", "Light", resetToDefault)}
        {option("dark", "🌙", "Dark", () => {
          setChoice({ kind: "custom", mode: "dark", input: BW_DARK_INPUT });
          resetUi();
        })}
        {option("custom", "🎨", "Custom", () => void navigate("/appearance"))}
      </div>
    </section>
  );
}
