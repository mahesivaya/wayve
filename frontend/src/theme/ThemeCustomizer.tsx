// Theme customizer UI. Two tabs:
//   Presets — gallery of curated themes. Click to apply + persist.
//   Custom  — macro-style 2D color grid + segmented sliders (chroma,
//             saturation, contrast, depth). Live-preview as you drag.
//
// The preview is driven by previewInput/clearPreview from the context, which
// writes to :root without persisting — so dragging is cheap and the page
// can be reverted instantly by switching tabs or hitting Reset.

import { useEffect, useMemo, useState } from "react";

import ColorGrid from "./ColorGrid";
import TickSlider from "./TickSlider";
import { PRESETS, type ThemePreset } from "./themePresets";
import { type ThemeMode } from "./customThemeShared";
import { useCustomTheme } from "./useCustomTheme";
import { DEFAULT_INPUT, generatePalette, type PaletteInput } from "./palette";
import "./themeCustomizer.css";

type Tab = "presets" | "custom";

// Macro-style quick background swatches. One click sets the page background
// (and matching accents) to a curated color + mode — no grid, no hex typing.
// Each entry runs through the same generator as everything else, so the dot
// preview is exactly the background you'll get.
const BACKGROUNDS: { id: string; label: string; mode: ThemeMode; input: PaletteInput }[] = [
  { id: "bg-navy", label: "Navy", mode: "dark", input: { ...DEFAULT_INPUT, hue: 230, chroma: 0.16 } },
  { id: "bg-slate", label: "Slate", mode: "dark", input: { ...DEFAULT_INPUT, hue: 220, chroma: 0.05 } },
  { id: "bg-black", label: "Ink", mode: "dark", input: { ...DEFAULT_INPUT, hue: 250, chroma: 0, depth: 0.04 } },
  { id: "bg-forest", label: "Forest", mode: "dark", input: { ...DEFAULT_INPUT, hue: 155, chroma: 0.14 } },
  { id: "bg-plum", label: "Plum", mode: "dark", input: { ...DEFAULT_INPUT, hue: 300, chroma: 0.15 } },
  { id: "bg-light", label: "Light", mode: "light", input: { ...DEFAULT_INPUT, hue: 220, chroma: 0.12 } },
  { id: "bg-cream", label: "Cream", mode: "light", input: { ...DEFAULT_INPUT, hue: 75, chroma: 0.12 } },
  { id: "bg-rose", label: "Rose", mode: "light", input: { ...DEFAULT_INPUT, hue: 350, chroma: 0.12 } },
];

// Swatch shown on each preset card — uses the same generator the rest of the
// app uses so the preview matches what the user will see after picking it.
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

  // Chroma slider track: gray → fully-saturated accent at the current hue.
  // Recomputed when the hue changes so the user can see what intensity the
  // current hue can reach.
  const chromaTrack = `linear-gradient(to right, oklch(0.70 0 ${input.hue}), oklch(0.65 0.28 ${input.hue}))`;

  return (
    <div className="theme-customizer">
      <div className="theme-customizer-header">
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
        </div>
        <button
          type="button"
          className={`theme-mode-wheel theme-mode-wheel--${mode}`}
          onClick={() => setMode(mode === "light" ? "dark" : "light")}
          title={`Switch to ${mode === "light" ? "dark" : "light"} mode (currently ${mode})`}
          aria-label={`Switch to ${mode === "light" ? "dark" : "light"} mode`}
          aria-pressed={mode === "dark"}
        />

        <button
          type="button"
          className="theme-customizer-reset"
          onClick={resetToDefault}
          title="Restore stylesheet defaults"
        >
          Reset
        </button>
      </div>

      <div className="theme-bg-quick" role="group" aria-label="Background color">
        <span className="theme-bg-quick-label">Background</span>
        <div className="theme-bg-swatches">
          {BACKGROUNDS.map((bg) => {
            const surface = generatePalette(bg.input, bg.mode).surface;
            const active =
              choice.kind === "custom" &&
              choice.mode === bg.mode &&
              choice.input.hue === bg.input.hue &&
              choice.input.chroma === bg.input.chroma;
            return (
              <button
                key={bg.id}
                type="button"
                className={`theme-bg-swatch ${active ? "active" : ""}`}
                style={{ background: surface }}
                title={bg.label}
                aria-label={`${bg.label} background`}
                aria-pressed={active}
                onClick={() =>
                  setChoice({ kind: "custom", mode: bg.mode, input: bg.input })
                }
              />
            );
          })}
        </div>
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
          <ColorGrid
            hue={input.hue}
            chroma={input.chroma}
            onChange={({ hue, chroma }) => setInput({ ...input, hue, chroma })}
          />

          <div className="theme-custom-sliders">
            <div className="theme-custom-row">
              <label>Chroma</label>
              <TickSlider
                value={input.chroma}
                min={0}
                max={0.3}
                step={0.01}
                onChange={(chroma) => setInput({ ...input, chroma })}
                variant="gradient"
                trackBackground={chromaTrack}
                ariaLabel="Chroma"
              />
            </div>

            <div className="theme-custom-row">
              <label>Saturation</label>
              <TickSlider
                value={input.saturation}
                min={0}
                max={1.5}
                step={0.05}
                onChange={(saturation) => setInput({ ...input, saturation })}
                variant="ticks"
                ariaLabel="Saturation"
              />
            </div>

            <div className="theme-custom-row">
              <label>Contrast</label>
              <TickSlider
                value={input.contrast}
                min={0}
                max={1}
                step={0.05}
                onChange={(contrast) => setInput({ ...input, contrast })}
                variant="ticks"
                ariaLabel="Contrast"
              />
            </div>

            <div className="theme-custom-row">
              <label>Depth</label>
              <TickSlider
                value={input.depth}
                min={-0.05}
                max={0.05}
                step={0.005}
                onChange={(depth) => setInput({ ...input, depth })}
                variant="ticks"
                ariaLabel="Depth"
              />
            </div>
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
