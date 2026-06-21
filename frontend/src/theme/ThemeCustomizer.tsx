// Theme customizer UI (macro.com-style). Layout:
//
//   Header   — Basic / Advanced editor tabs · mode wheel · Reset
//   Editor   — Basic: one-click background swatches
//              Advanced: 2D color grid + 4 sliders + toolbar
//              (name · Save · Randomize · Import)
//   Library  — Themes / UI sub-tabs
//              Themes: presets + the user's saved themes (apply / copy /
//                      rename / delete)
//              UI: a curated set of safe per-role color overrides with a
//                  contrast guard + Reset
//
// Advanced edits live-preview via previewInput/clearPreview from the context
// (writes to :root without persisting), so dragging is cheap and revertible.

import { useEffect, useMemo, useState } from "react";

import ColorGrid from "./ColorGrid";
import TickSlider from "./TickSlider";
import {
  UI_OVERRIDE_ROLES,
  type SavedTheme,
  type ThemeMode,
} from "./customThemeShared";
import { TOKEN_VAR } from "./customTokens";
import {
  DEFAULT_INPUT,
  contrastRatio,
  cssColorToHex,
  generatePalette,
  randomInput,
  type PaletteInput,
} from "./palette";
import "./themeCustomizer.css";
import { PRESETS, type ThemePreset } from "./themePresets";
import { useCustomTheme } from "./useCustomTheme";

type LibTab = "themes" | "ui";

// --- Thin line-art header icons (match the macro toolbar) ---
function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="theme-icon" aria-hidden="true">
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7V4" />
      <rect x="8" y="13" width="8" height="6" />
    </svg>
  );
}

function DiceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="theme-icon" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1.1" />
      <circle cx="15" cy="9" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="9" cy="15" r="1.1" />
      <circle cx="15" cy="15" r="1.1" />
    </svg>
  );
}

// Half-filled circle = light/dark contrast toggle (replaces the color wheel).
function ContrastIcon() {
  return (
    <svg viewBox="0 0 24 24" className="theme-icon" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Minimum WCAG ratio between text and surface before we warn the user.
const MIN_CONTRAST = 4.5;

// Macro-style quick background swatches. One click sets the page background
// (and matching accents) to a curated color + mode — no grid, no hex typing.
const BACKGROUNDS: {
  id: string;
  label: string;
  mode: ThemeMode;
  input: PaletteInput;
}[] = [
    {
      id: "bg-navy",
      label: "Navy",
      mode: "dark",
      input: { ...DEFAULT_INPUT, hue: 230, chroma: 0.16 },
    },
    {
      id: "bg-slate",
      label: "Slate",
      mode: "dark",
      input: { ...DEFAULT_INPUT, hue: 220, chroma: 0.05 },
    },
    {
      id: "bg-black",
      label: "Ink",
      mode: "dark",
      input: { ...DEFAULT_INPUT, hue: 250, chroma: 0, depth: 0.04 },
    },
    {
      id: "bg-forest",
      label: "Forest",
      mode: "dark",
      input: { ...DEFAULT_INPUT, hue: 155, chroma: 0.14 },
    },
    {
      id: "bg-plum",
      label: "Plum",
      mode: "dark",
      input: { ...DEFAULT_INPUT, hue: 300, chroma: 0.15 },
    },
    {
      id: "bg-light",
      label: "Light",
      mode: "light",
      input: { ...DEFAULT_INPUT, hue: 220, chroma: 0.12 },
    },
    {
      id: "bg-cream",
      label: "Cream",
      mode: "light",
      input: { ...DEFAULT_INPUT, hue: 75, chroma: 0.12 },
    },
    {
      id: "bg-rose",
      label: "Rose",
      mode: "light",
      input: { ...DEFAULT_INPUT, hue: 350, chroma: 0.12 },
    },
  ];

// Pure black & white inputs for the Contrast button's monochrome toggle.
// `chroma: 0, saturation: 0` makes generatePalette() emit a fully greyscale
// palette (surfaces, text, borders, buttons AND status colors). `saturation: 0`
// also distinguishes these from the colored swatches above (which keep the
// default saturation of 1), so `isBwInput()` can tell B&W apart from, e.g.,
// the chroma-0 "Ink" swatch.
const BW_LIGHT_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  // +depth lifts the surface lightnesses (page bg + cards) to pure white in
  // generatePalette (surfaceSoftL = 0.96 + depth, clamped at 1.0). At depth 0
  // the B&W "white" theme rendered the background at oklch 96% — a flat gray
  // that read as "not clean white". depth only touches surfaces, so text/border
  // contrast is unchanged.
  depth: 0.04,
};
const BW_DARK_INPUT: PaletteInput = {
  hue: 0,
  chroma: 0,
  saturation: 0,
  contrast: 1,
  depth: 0.05,
};

function isBwInput(input: PaletteInput): boolean {
  return input.chroma === 0 && input.saturation === 0;
}

// A compact 3-dot swatch for a library row — same generator as the live theme.
function RowSwatch({ input, mode }: { input: PaletteInput; mode: ThemeMode }) {
  const tokens = useMemo(() => generatePalette(input, mode), [input, mode]);
  return (
    <span
      className="theme-row-swatch"
      style={{ background: tokens.surface, borderColor: tokens.border }}
    >
      <span style={{ background: tokens.primary }} />
      <span style={{ background: tokens["accent-purple"] }} />
      <span style={{ background: tokens["text-primary"] }} />
    </span>
  );
}

export default function ThemeCustomizer() {
  const {
    choice,
    setChoice,
    resetToDefault,
    previewInput,
    clearPreview,
    library,
    saveTheme,
    renameTheme,
    deleteTheme,
    ui,
    setUiOverride,
    clearUiOverride,
    resetUi,
    baseTokens,
  } = useCustomTheme();

  const [libTab, setLibTab] = useState<LibTab>("themes");

  // Seed the advanced editor from the active choice when it's custom/saved.
  const initial = useMemo(() => {
    if (choice.kind === "custom")
      return { input: choice.input, mode: choice.mode };
    if (choice.kind === "saved") {
      const saved = library.find((t) => t.id === choice.id);
      if (saved) return { input: saved.input, mode: saved.mode };
    }
    return { input: DEFAULT_INPUT, mode: "light" as ThemeMode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [input, setInput] = useState<PaletteInput>(initial.input);
  const [mode, setMode] = useState<ThemeMode>(initial.mode);
  const [name, setName] = useState("New Theme");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Single-view editor: the sliders/grid live-preview the current input at all
  // times. Discrete picks (swatch/preset/saved/B&W) sync `input`/`mode` so this
  // preview matches the pick instead of masking it.
  useEffect(() => {
    previewInput(input, mode);
  }, [input, mode, previewInput]);
  // Revert an unsaved preview when the panel closes (the old code did this when
  // leaving the Advanced tab). Unmount-only so it doesn't clear+reapply — and
  // flicker — on every slider tick.
  useEffect(() => () => clearPreview(), [clearPreview]);

  // Chroma slider track: gray → fully-saturated accent at the current hue.
  const chromaTrack = `linear-gradient(to right, oklch(0.70 0 ${input.hue}), oklch(0.65 0.28 ${input.hue}))`;

  const activePresetId = choice.kind === "preset" ? choice.presetId : null;
  const activeSavedId = choice.kind === "saved" ? choice.id : null;
  // Whether a black & white theme is currently applied (set by the Contrast
  // button). Used for the button's pressed state and to decide the next toggle.
  const bwActive = choice.kind === "custom" && isBwInput(choice.input);

  // Contrast button: toggle a pure monochrome theme. From any colored theme the
  // first click → white (B&W light); the next → black (B&W dark); then back to
  // white. Picking a colored swatch below clears B&W, so the next click restarts
  // at white.
  const toggleBlackAndWhite = () => {
    const nextMode: ThemeMode =
      bwActive && choice.kind === "custom" && choice.mode === "light"
        ? "dark"
        : "light";
    const nextInput = nextMode === "dark" ? BW_DARK_INPUT : BW_LIGHT_INPUT;
    setChoice({ kind: "custom", mode: nextMode, input: nextInput });
    setInput(nextInput);
    setMode(nextMode);
  };

  // --- actions ---------------------------------------------------------------
  // Sync the slider state to each discrete pick so the always-on preview shows
  // the pick instead of the previous slider input.

  // Commit a free-form editor change (grid / sliders / randomize / import).
  // These used to only live-preview via previewInput, so clearPreview() on
  // panel close reverted them — the user would pick a colour from the grid,
  // click away, and watch it snap back to the last committed theme. Persisting
  // the edit as the active custom choice (the same thing the background
  // swatches already do) makes it stick.
  const commitInput = (next: PaletteInput, nextMode: ThemeMode = mode) => {
    setInput(next);
    setMode(nextMode);
    setChoice({ kind: "custom", mode: nextMode, input: next });
  };

  const applyPreset = (presetId: string) => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setInput(preset.input);
      setMode(preset.mode);
    }
    setChoice({ kind: "preset", presetId });
  };

  const applySaved = (t: SavedTheme) => {
    setInput(t.input);
    setMode(t.mode);
    setChoice({ kind: "saved", id: t.id });
  };

  const handleSave = () => {
    saveTheme(name, mode, input);
    setName("New Theme");
  };

  const handleRandomize = () => {
    commitInput(randomInput());
  };

  const copyTheme = (payload: {
    name: string;
    mode: ThemeMode;
    input: PaletteInput;
  }) => {
    try {
      void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    } catch {
      // clipboard blocked — no-op
    }
  };

  const handleImport = () => {
    setImportError(null);
    try {
      const parsed = JSON.parse(importText) as {
        name?: string;
        mode?: ThemeMode;
        input?: PaletteInput;
      };
      if (
        !parsed.input ||
        typeof parsed.input.hue !== "number" ||
        (parsed.mode !== "light" && parsed.mode !== "dark")
      ) {
        throw new Error("missing input/mode");
      }
      commitInput(parsed.input, parsed.mode);
      if (parsed.name) setName(parsed.name);
      setImportOpen(false);
      setImportText("");
    } catch {
      setImportError("That doesn't look like an exported theme.");
    }
  };

  // --- UI tab contrast guard -------------------------------------------------
  // getComputedStyle returns a LIVE declaration, so reading it later always
  // reflects the current :root values — compute it once.
  const rootStyle = useMemo(
    () =>
      typeof document !== "undefined"
        ? getComputedStyle(document.documentElement)
        : null,
    []
  );

  const effectiveColor = (role: keyof typeof TOKEN_VAR): string => {
    const fromUi = ui[role];
    if (fromUi) return fromUi;
    const fromBase = baseTokens[role];
    if (fromBase) return fromBase;
    return rootStyle?.getPropertyValue(TOKEN_VAR[role]).trim() || "#888888";
  };

  const textVsSurface = useMemo(
    () =>
      contrastRatio(effectiveColor("text-primary"), effectiveColor("surface")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ui, baseTokens, rootStyle]
  );
  const lowContrast = textVsSurface !== null && textVsSurface < MIN_CONTRAST;

  return (
    <div className="theme-customizer">
      <div className="theme-customizer-header">
        <div className="theme-header-tools">
          <button
            type="button"
            className="theme-icon-btn"
            onClick={handleSave}
            title="Save to your themes"
            aria-label="Save theme"
          >
            <SaveIcon />
          </button>
          <button
            type="button"
            className="theme-icon-btn"
            onClick={handleRandomize}
            title="Randomize"
            aria-label="Randomize theme"
          >
            <DiceIcon />
          </button>
          <button
            type="button"
            className="theme-icon-btn"
            onClick={toggleBlackAndWhite}
            title={
              bwActive
                ? `Black & white: ${choice.kind === "custom" && choice.mode === "dark" ? "black — click for white" : "white — click for black"}`
                : "Black & white"
            }
            aria-label="Toggle black and white"
            aria-pressed={bwActive}
          >
            <ContrastIcon />
          </button>
        </div>

        <input
          type="text"
          className="theme-name-input theme-name-input--header"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New Theme"
          aria-label="Theme name"
        />
      </div>

      <div
        className="theme-bg-quick"
        role="group"
        aria-label="Background color"
      >
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
                onClick={() => {
                  setInput(bg.input);
                  setMode(bg.mode);
                  setChoice({
                    kind: "custom",
                    mode: bg.mode,
                    input: bg.input,
                  });
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="theme-custom-panel">
        <ColorGrid
          hue={input.hue}
          chroma={input.chroma}
          onChange={({ hue, chroma }) => commitInput({ ...input, hue, chroma })}
        />

        <div className="theme-custom-sliders">
          <div className="theme-custom-row">
            <label>Chroma</label>
            <TickSlider
              value={input.chroma}
              min={0}
              max={0.3}
              step={0.01}
              onChange={(chroma) => commitInput({ ...input, chroma })}
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
              onChange={(saturation) => commitInput({ ...input, saturation })}
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
              onChange={(contrast) => commitInput({ ...input, contrast })}
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
              onChange={(depth) => commitInput({ ...input, depth })}
              variant="ticks"
              ariaLabel="Depth"
            />
          </div>
        </div>

        <div className="theme-advanced-toolbar">
          <button
            type="button"
            className="theme-tool-btn"
            onClick={() => copyTheme({ name, mode, input })}
            title="Copy this theme to clipboard"
          >
            📋 Copy
          </button>
          <button
            type="button"
            className="theme-tool-btn"
            onClick={() => {
              setImportOpen((o) => !o);
              setImportError(null);
            }}
            title="Import a theme from clipboard text"
          >
            Import
          </button>
          <button
            type="button"
            className="theme-customizer-revert"
            onClick={() => commitInput(DEFAULT_INPUT)}
          >
            Revert sliders
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

        {importOpen && (
          <div className="theme-import">
            <textarea
              className="theme-import-text"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='Paste an exported theme JSON, e.g. {"name":"…","mode":"dark","input":{…}}'
              rows={4}
            />
            {importError && (
              <div className="theme-import-error">{importError}</div>
            )}
            <div className="theme-import-actions">
              <button
                type="button"
                className="theme-customizer-apply"
                onClick={handleImport}
              >
                Apply import
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ----- Library: Themes / UI ----- */}
      <div className="theme-lib">
        <div className="theme-lib-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={libTab === "themes"}
            className={`theme-customizer-tab ${libTab === "themes" ? "active" : ""}`}
            onClick={() => setLibTab("themes")}
          >
            Themes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={libTab === "ui"}
            className={`theme-customizer-tab ${libTab === "ui" ? "active" : ""}`}
            onClick={() => setLibTab("ui")}
          >
            UI
          </button>
        </div>

        {libTab === "themes" && (
          <div className="theme-lib-list">
            {PRESETS.map((preset: ThemePreset) => (
              <div
                key={preset.id}
                className={`theme-lib-row ${activePresetId === preset.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="theme-lib-apply"
                  onClick={() => applyPreset(preset.id)}
                  title={`Apply ${preset.name}`}
                >
                  <RowSwatch input={preset.input} mode={preset.mode} />
                  <span className="theme-lib-name">{preset.name}</span>
                </button>
                <button
                  type="button"
                  className="theme-lib-icon"
                  onClick={() =>
                    copyTheme({
                      name: preset.name,
                      mode: preset.mode,
                      input: preset.input,
                    })
                  }
                  title="Copy theme"
                  aria-label={`Copy ${preset.name}`}
                >
                  📋
                </button>
              </div>
            ))}

            {library.map((t) => (
              <div
                key={t.id}
                className={`theme-lib-row ${activeSavedId === t.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="theme-lib-apply"
                  onClick={() => applySaved(t)}
                  title={`Apply ${t.name}`}
                >
                  <RowSwatch input={t.input} mode={t.mode} />
                  {renamingId === t.id ? (
                    <input
                      type="text"
                      className="theme-lib-rename"
                      defaultValue={t.name}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        renameTheme(t.id, e.target.value);
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          renameTheme(t.id, e.currentTarget.value);
                          setRenamingId(null);
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="theme-lib-name">{t.name}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="theme-lib-icon"
                  onClick={() =>
                    copyTheme({ name: t.name, mode: t.mode, input: t.input })
                  }
                  title="Copy theme"
                  aria-label={`Copy ${t.name}`}
                >
                  📋
                </button>
                <button
                  type="button"
                  className="theme-lib-icon"
                  onClick={() => setRenamingId(t.id)}
                  title="Rename"
                  aria-label={`Rename ${t.name}`}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  className="theme-lib-icon theme-lib-delete"
                  onClick={() => deleteTheme(t.id)}
                  title="Delete"
                  aria-label={`Delete ${t.name}`}
                >
                  ✕
                </button>
              </div>
            ))}

            {library.length === 0 && (
              <div className="theme-lib-empty">
                Save a theme from the Advanced tab to build your library.
              </div>
            )}
          </div>
        )}

        {libTab === "ui" && (
          <div className="theme-ui-knobs">
            {lowContrast && (
              <div className="theme-ui-warning" role="alert">
                ⚠ Low contrast between Text and Surface (
                {textVsSurface?.toFixed(1)}:1). Text may be hard to read.
              </div>
            )}
            {UI_OVERRIDE_ROLES.map(({ role, label }) => {
              const overridden = ui[role] !== undefined;
              return (
                <div key={role} className="theme-ui-row">
                  <label htmlFor={`ui-${role}`}>{label}</label>
                  <input
                    id={`ui-${role}`}
                    type="color"
                    className="theme-ui-color"
                    value={cssColorToHex(effectiveColor(role))}
                    onChange={(e) => setUiOverride(role, e.target.value)}
                  />
                  {overridden && (
                    <button
                      type="button"
                      className="theme-lib-icon"
                      onClick={() => clearUiOverride(role)}
                      title="Clear override"
                      aria-label={`Clear ${label} override`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="theme-customizer-revert"
              onClick={resetUi}
            >
              Reset UI overrides
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
