import { useState } from "react";

import { CodeFile } from "../github/CodeFile";
import {
  CODE_FONT_SIZES,
  CODE_FONT_WEIGHTS,
  CODE_FONTS,
  CODE_LINE_HEIGHTS,
  CODE_TAB_SIZES,
  CODE_THEMES,
  DEFAULT_CODE_SETTINGS,
  saveCodeSettings,
  useCodeSettings,
  type CodeSettings,
} from "../github/codeSettings";
import { CommitPatch } from "../github/commitDiff";
import { DEFAULT_DIFF_PREFS } from "../github/diffPrefs";
import "./codeSettingsCard.css";

const SAMPLES = {
  Rust: {
    filename: "config.rs",
    patch: `@@ -1,7 +1,7 @@
 // Where requests are sent.
-const RETRIES: u32 = 1;
+const RETRIES: u32 = 3;
 
 struct Config { url: String, timeout: u32 }
 
 fn endpoint(config: &Config, path: &str) -> String {
     format!("{}/{}", config.url, path)`,
  },
  TypeScript: {
    filename: "config.ts",
    patch: `@@ -1,7 +1,7 @@
 // Where requests are sent.
-const RETRIES = 1;
+const RETRIES: number = 3;
 
 type Config = { url: string; timeout: number };
 
 export function endpoint(config: Config, path: string): string {
   return \`\${config.url}/\${path}\`;`,
  },
  Python: {
    filename: "config.py",
    patch: `@@ -1,7 +1,7 @@
 # Where requests are sent.
-RETRIES = 1
+RETRIES: int = 3
 
 class Config:
     url: str = "https://api.example.com"
 
 def endpoint(config: Config, path: str) -> str:`,
  },
  Go: {
    filename: "config.go",
    patch: `@@ -1,7 +1,7 @@
 // Where requests are sent.
-const retries = 1
+const retries int = 3
 
 type Config struct { URL string }
 
 func endpoint(c Config, path string) string {
 	return fmt.Sprintf("%s/%s", c.URL, path)`,
  },
};
type SampleName = keyof typeof SAMPLES;

// The sample as a whole file: the patch's new side.
const fileFromPatch = (patch: string) =>
  patch
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("-"))
    .map((line) => line.slice(1))
    .join("\n");

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="settings-usage-row code-settings-row">
      <span>{label}</span>
      <span className={`toggle-switch${checked ? " on" : ""}`}>
        <input
          type="checkbox"
          className="toggle-switch-input"
          role="switch"
          aria-checked={checked}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-switch-slider" aria-hidden="true" />
      </span>
    </label>
  );
}

// Code appearance on the General settings page. Every change applies at once,
// to the sample here and to code anywhere else in the app.
export default function CodeSettingsCard() {
  const settings = useCodeSettings();
  const [sample, setSample] = useState<SampleName>("Rust");
  const [view, setView] = useState<"diff" | "file">("diff");
  const change = (patch: Partial<CodeSettings>) =>
    saveCodeSettings({ ...settings, ...patch });

  const select = (
    label: string,
    value: string,
    options: [string, string][],
    onChange: (next: string) => void
  ) => (
    <label className="settings-usage-row code-settings-row">
      <span>{label}</span>
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  const fontName =
    settings.customFont.trim() || CODE_FONTS[settings.font]?.label || "Default";
  const { filename, patch } = SAMPLES[sample];
  const isDefault =
    JSON.stringify(settings) === JSON.stringify(DEFAULT_CODE_SETTINGS);

  return (
    <section className="settings-card code-settings">
      <h2 className="settings-card-title">Code</h2>
      <div className="settings-rows">
        {select(
          "Code theme",
          settings.theme,
          [
            ["auto", "Match interface"],
            ...Object.entries(CODE_THEMES).map(
              ([id, theme]): [string, string] => [id, theme.label]
            ),
          ],
          (theme) => change({ theme })
        )}

        <details className="code-settings-group" open>
          <summary>
            <span>Font</span>
            <span className="code-settings-summary">
              {settings.fontSize}px,{" "}
              {CODE_FONT_WEIGHTS[settings.fontWeight].label}, {fontName}
            </span>
          </summary>
          {select(
            "Font",
            settings.font,
            [
              ["default", "Default"],
              ...Object.entries(CODE_FONTS).map(
                ([id, font]): [string, string] => [id, font.label]
              ),
            ],
            (font) => change({ font })
          )}
          <label className="settings-usage-row code-settings-row">
            <span>Custom font family</span>
            <input
              type="text"
              className="settings-select code-settings-input"
              placeholder="Font family name"
              value={settings.customFont}
              onChange={(e) => change({ customFont: e.target.value })}
            />
          </label>
          {select(
            "Font size",
            String(settings.fontSize),
            CODE_FONT_SIZES.map((size) => [String(size), `${size}px`]),
            (size) => change({ fontSize: Number(size) })
          )}
          {select(
            "Font weight",
            settings.fontWeight,
            Object.entries(CODE_FONT_WEIGHTS).map(([id, w]) => [id, w.label]),
            (id) => change({ fontWeight: id as CodeSettings["fontWeight"] })
          )}
          {select(
            "Line height",
            settings.lineHeight,
            Object.entries(CODE_LINE_HEIGHTS).map(([id, h]) => [id, h.label]),
            (id) => change({ lineHeight: id as CodeSettings["lineHeight"] })
          )}
          <Toggle
            label="Italic comments"
            checked={settings.italicComments}
            onChange={(italicComments) => change({ italicComments })}
          />
          <Toggle
            label="Font ligatures"
            checked={settings.ligatures}
            onChange={(ligatures) => change({ ligatures })}
          />
        </details>

        <details className="code-settings-group">
          <summary>
            <span>File view</span>
            <span className="code-settings-summary">
              Tab width {settings.tabSize}
            </span>
          </summary>
          {select(
            "Tab width",
            String(settings.tabSize),
            CODE_TAB_SIZES.map((size) => [String(size), `${size} spaces`]),
            (size) => change({ tabSize: Number(size) })
          )}
          <Toggle
            label="Line numbers"
            checked={settings.lineNumbers}
            onChange={(lineNumbers) => change({ lineNumbers })}
          />
          <Toggle
            label="Wrap long lines"
            checked={settings.wrapLines}
            onChange={(wrapLines) => change({ wrapLines })}
          />
        </details>
      </div>

      <div className="code-settings-preview-head">
        <select
          className="settings-select"
          aria-label="Preview view"
          value={view}
          onChange={(e) => setView(e.target.value as "diff" | "file")}
        >
          <option value="diff">Diff</option>
          <option value="file">File</option>
        </select>
        <select
          className="settings-select"
          aria-label="Preview language"
          value={sample}
          onChange={(e) => setSample(e.target.value as SampleName)}
        >
          {Object.keys(SAMPLES).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        {!isDefault && (
          <button
            type="button"
            className="settings-secondary-btn code-settings-reset"
            onClick={() => saveCodeSettings(DEFAULT_CODE_SETTINGS)}
          >
            Reset to defaults
          </button>
        )}
      </div>
      <div
        className="code-settings-preview github-preview"
        aria-label="Preview"
      >
        {view === "diff" ? (
          <CommitPatch
            key={sample}
            patch={patch}
            filename={filename}
            prefs={{ ...DEFAULT_DIFF_PREFS, layout: "unified" }}
          />
        ) : (
          <CodeFile path={filename} text={fileFromPatch(patch)} />
        )}
      </div>
    </section>
  );
}
