import { useNavigate } from "react-router-dom";

import { BW_DARK_INPUT, isBwInput } from "../theme/blackAndWhite";
import { useCustomTheme } from "../theme/useCustomTheme";

type ThemeMode = "light" | "dark" | "custom";

// The Appearance entry on the General settings page (narrow screens, which
// have no settings rail): one tap for Light or Dark, and Custom opens the full
// theme editor to create or pick other themes.
export default function AppearanceCard() {
  const navigate = useNavigate();
  const { choice, ui, setChoice, resetToDefault, resetUi } = useCustomTheme();

  // Light is the app's plain white default; Dark is the editor's plain black
  // (its black & white toggle), not a tinted dark preset. Per-role colour
  // overrides make either a custom look, so only an untouched one counts.
  const plain = Object.keys(ui).length === 0;
  const plainBlack =
    choice.kind === "custom" &&
    choice.mode === "dark" &&
    isBwInput(choice.input);
  const current: ThemeMode =
    plain && choice.kind === "default"
      ? "light"
      : plain && plainBlack
        ? "dark"
        : "custom";

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
