// Theme customizer UI. Two tabs:
//   Presets — gallery of curated themes. Click to apply + persist.
//   Custom  — macro-style sliders (hue, chroma, saturation, contrast, depth)
//             that live-preview as you drag, with Apply / Reset controls.
//
// The preview is driven by previewInput/clearPreview from the context, which
// writes to :root without persisting — so dragging a slider is cheap and the
// page can be reverted instantly by switching tabs or hitting Reset.

import { useEffect, useMemo, useState } from "react";

import { PRESETS, type ThemePreset } from "./themePresets";
import { type ThemeMode } from "./customThemeShared";
import { useCustomTheme } from "./useCustomTheme";
import { DEFAULT_INPUT, generatePalette, type PaletteInput } from "./palette";
import "./themeCustomizer.css";

type Tab = "presets" | "custom";

// Swatch shown on each preset card — uses generated palette so the preview
// reflects what the user will actually get.
function PresetSwatch({ preset }: { preset: ThemePreset }) {
  const tokens = useMemo(
    () => generatePalette(preset.input, preset.mode),
    [preset],
  );
  return (
    <div
      className="theme-preset-swatch"
      style={{
        background: tokens.surface,
        borderColor: tokens.border,
      }}
    >
      <div
        className="theme-preset-swatch-dot"
        style={{ background: tokens.primary }}
      />
      <div
        className="theme-preset-swatch-dot"
        style={{ background: tokens["accent-purple"] }}
      />
      <div
        className="theme-preset-swatch-dot"
        style={{ background: tokens.success }}
      />
      <div
        className="theme-preset-swatch-bar"
        style={{ background: tokens["text-primary"] }}
      />
      <div
        className="theme-preset-swatch-bar theme-preset-swatch-bar-short"
        style={{ background: tokens["text-secondary"] }}
      />
    </div>
  );
}

export default function ThemeCustomizer() {
  const { choice, setChoice, resetToDefault, previewInput, clearPreview } = useCustomTheme();
  const [tab, setTab] = useState<Tab>("presets");
  const [input, setInput] = useState<PaletteInput>(() =>
    choice.kind === "custom" ? choice.input : DEFAULT_INPUT,
  );
  const [mode, setMode] = useState<ThemeMode>(() =>
    choice.kind === "custom" ? choice.mode : "light",
  );

  // Whenever the custom tab is active, push the current sliders into a live
  // preview. Switching away from the tab clears the preview so the persisted
  // choice (preset or default) is restored.
  useEffect(() => {
    if (tab !== "custom") {
      clearPreview();
      return;
    }
    previewInput(input, mode);
  }, [tab, input, mode, previewInput, clearPreview]);

  const activePresetId = choice.kind === "preset" ? choice.presetId : null;

  return (
    <div className="theme-customizer">
      <div className="theme-customizer-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "presets"}
          className={`theme-customizer-tab ${tab === "presets" ? "active" : ""}`}
          onClick={() => setTab("presets")}
        >
          Presets
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "custom"}
          className={`theme-customizer-tab ${tab === "custom" ? "active" : ""}`}
          onClick={() => setTab("custom")}
        >
          Custom
        </button>
        <button
          type="button"
          className="theme-customizer-reset"
          onClick={resetToDefault}
          title="Restore stylesheet defaults"
        >
          Reset
        </button>
      </div>

      {tab === "presets" && (
        <div className="theme-preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`theme-preset-card ${activePresetId === preset.id ? "active" : ""}`}
              onClick={() => setChoice({ kind: "preset", presetId: preset.id })}
            >
              <PresetSwatch preset={preset} />
              <div className="theme-preset-name">{preset.name}</div>
              <div className="theme-preset-desc">{preset.description}</div>
              <div className="theme-preset-mode">{preset.mode}</div>
            </button>
          ))}
        </div>
      )}

      {tab === "custom" && (
        <div className="theme-custom-panel">
          <div className="theme-custom-mode">
            <label>
              <input
                type="radio"
                name="theme-mode"
                checked={mode === "light"}
                onChange={() => setMode("light")}
              />
              Light
            </label>
            <label>
              <input
                type="radio"
                name="theme-mode"
                checked={mode === "dark"}
                onChange={() => setMode("dark")}
              />
              Dark
            </label>
          </div>

          <div className="theme-custom-row">
            <label htmlFor="theme-hue">Hue ({input.hue.toFixed(0)}°)</label>
            <input
              id="theme-hue"
              type="range"
              min={0}
              max={360}
              step={1}
              value={input.hue}
              onChange={(e) => setInput({ ...input, hue: Number(e.target.value) })}
              className="theme-custom-hue-slider"
            />
          </div>

          <div className="theme-custom-row">
            <label htmlFor="theme-chroma">Chroma ({input.chroma.toFixed(2)})</label>
            <input
              id="theme-chroma"
              type="range"
              min={0}
              max={0.30}
              step={0.01}
              value={input.chroma}
              onChange={(e) => setInput({ ...input, chroma: Number(e.target.value) })}
            />
          </div>

          <div className="theme-custom-row">
            <label htmlFor="theme-saturation">
              Saturation ({input.saturation.toFixed(2)})
            </label>
            <input
              id="theme-saturation"
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={input.saturation}
              onChange={(e) =>
                setInput({ ...input, saturation: Number(e.target.value) })
              }
            />
          </div>

          <div className="theme-custom-row">
            <label htmlFor="theme-contrast">
              Contrast ({input.contrast.toFixed(2)})
            </label>
            <input
              id="theme-contrast"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={input.contrast}
              onChange={(e) =>
                setInput({ ...input, contrast: Number(e.target.value) })
              }
            />
          </div>

          <div className="theme-custom-row">
            <label htmlFor="theme-depth">
              Depth ({input.depth.toFixed(3)})
            </label>
            <input
              id="theme-depth"
              type="range"
              min={-0.05}
              max={0.05}
              step={0.005}
              value={input.depth}
              onChange={(e) => setInput({ ...input, depth: Number(e.target.value) })}
            />
          </div>

          <div className="theme-custom-actions">
            <button
              type="button"
              className="theme-customizer-apply"
              onClick={() => setChoice({ kind: "custom", mode, input })}
            >
              Save custom theme
            </button>
            <button
              type="button"
              className="theme-customizer-revert"
              onClick={() => setInput(DEFAULT_INPUT)}
            >
              Revert sliders
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
