import { BW_DARK_INPUT } from "./blackAndWhite";
import { basicThemeMode, type BasicThemeMode } from "./basicThemeMode";
import { useCustomTheme } from "./useCustomTheme";

import "./themeModePicker.css";

const OPTIONS: { mode: BasicThemeMode; label: string; caption: string }[] = [
  {
    mode: "system",
    label: "System",
    caption: "Switches between light and dark with your device.",
  },
  { mode: "light", label: "Light", caption: "Always uses the light look." },
  { mode: "dark", label: "Dark", caption: "Always uses the dark look." },
];

// A small drawing of the app. Its colours are fixed, so each option shows what it
// picks whatever the current theme is.
function MiniApp({ tone }: { tone: "light" | "dark" }) {
  return (
    <span className={`mode-mini mode-mini--${tone}`} aria-hidden="true">
      <span className="mode-mini-window">
        <span className="mode-mini-side">
          <span className="mode-mini-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="mode-mini-nav mode-mini-nav--active" />
          <span className="mode-mini-nav" />
          <span className="mode-mini-nav mode-mini-nav--short" />
        </span>
        <span className="mode-mini-main">
          <span className="mode-mini-title" />
          <span className="mode-mini-line" />
          <span className="mode-mini-line mode-mini-line--short" />
          <span className="mode-mini-input">
            <i />
          </span>
        </span>
      </span>
    </span>
  );
}

// One-tap System / Light / Dark, above the full theme editor. None is selected
// while a custom theme or preset is active.
export default function ThemeModePicker({ onPick }: { onPick?: () => void }) {
  const { choice, ui, setChoice, resetToDefault, resetUi } = useCustomTheme();
  const current = basicThemeMode(choice, ui);

  const pick = (mode: BasicThemeMode) => {
    if (mode === "light") {
      // Keeps the saved theme library; it only clears the palette and overrides.
      resetToDefault();
    } else {
      setChoice(
        mode === "system"
          ? { kind: "system" }
          : { kind: "custom", mode: "dark", input: BW_DARK_INPUT }
      );
      resetUi();
    }
    onPick?.();
  };

  const caption =
    OPTIONS.find((option) => option.mode === current)?.caption ??
    "Using the custom theme below.";

  return (
    <>
      <div className="mode-picker" role="radiogroup" aria-label="Color theme">
        {OPTIONS.map(({ mode, label }) => (
          <label
            key={mode}
            className={`mode-option${current === mode ? " active" : ""}`}
          >
            <input
              type="radio"
              name="appearance-mode"
              value={mode}
              checked={current === mode}
              onChange={() => pick(mode)}
            />
            <span className="mode-preview">
              {mode === "system" ? (
                <>
                  <MiniApp tone="light" />
                  <span className="mode-preview-half">
                    <MiniApp tone="dark" />
                  </span>
                </>
              ) : (
                <MiniApp tone={mode} />
              )}
            </span>
            <span className="mode-option-label">{label}</span>
          </label>
        ))}
      </div>
      <p className="mode-caption">{caption}</p>
    </>
  );
}
