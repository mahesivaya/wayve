import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  getFontConfig,
  putMyFont,
  putOrgFont,
  putPlatformFont,
  type FontConfig,
} from "../api/platformUi";
import {
  FONT_OPTIONS,
  DEFAULT_FONT_KEY,
  normalizeFontKey,
  applyPlatformFont,
  cacheFontKey,
  type FontKey,
} from "./platformFonts";
import {
  TEXT_SIZES,
  applyTextSize,
  getTextSize,
  saveTextSize,
  type TextSize,
} from "./textSize";
import "./themeCustomizer.css";

type FontLevel = "me" | "org" | "platform";

// One block per font, each drawn in its own typeface so the choice previews
// itself. Real radios underneath, for arrow-key movement and screen readers.
function FontTiles({
  id,
  label,
  note,
  value,
  onChange,
}: {
  id: string;
  label: string;
  note: string;
  value: string | null | undefined;
  onChange: (next: FontKey) => void;
}) {
  const selected = normalizeFontKey(value);
  return (
    <div className="theme-ui-font">
      <span id={`${id}-label`} className="theme-font-label">
        {label}
      </span>
      <div
        className="theme-font-tiles"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
      >
        {FONT_OPTIONS.map((o) => (
          <label
            key={o.key}
            className={`theme-font-tile${o.key === selected ? " is-selected" : ""}`}
            style={{ fontFamily: o.stack }}
          >
            <input
              type="radio"
              name={id}
              value={o.key}
              checked={o.key === selected}
              onChange={() => onChange(o.key)}
            />
            <span>{o.label}</span>
            {o.key === selected && (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            )}
          </label>
        ))}
      </div>
      <p className="theme-ui-font-note">{note}</p>
    </div>
  );
}

// Text size as a row of percentage tabs. Applies as soon as it's picked.
function TextSizeTabs() {
  const [size, setSize] = useState<TextSize>(getTextSize);
  const pick = (next: TextSize) => {
    setSize(next);
    saveTextSize(next);
    applyTextSize(next);
  };
  return (
    <div className="theme-ui-font">
      <span id="text-size-label" className="theme-font-label">
        Text size
      </span>
      <div
        className="theme-size-tabs"
        role="radiogroup"
        aria-labelledby="text-size-label"
      >
        {TEXT_SIZES.map((option) => (
          <label
            key={option}
            className={`theme-size-tab${option === size ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="text-size"
              value={option}
              checked={option === size}
              onChange={() => pick(option)}
            />
            {option}%
          </label>
        ))}
      </div>
      <p className="theme-ui-font-note">
        Makes the app&apos;s text larger or smaller on this browser.
      </p>
    </div>
  );
}

// The Text card on the Appearance page: text size, then the fonts. The app font
// resolves by scope, most specific first: the user's own, then their org's,
// then the platform default. The fonts appear once the config has loaded.
export default function FontSettings() {
  const { user } = useAuth();
  const [fontCfg, setFontCfg] = useState<FontConfig | null>(null);
  const [fontSaving, setFontSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void getFontConfig()
      .then((cfg) => {
        if (!cancelled) setFontCfg(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  const refreshFonts = () =>
    void getFontConfig()
      .then(setFontCfg)
      .catch(() => {});

  const setFont = async (level: FontLevel, next: FontKey) => {
    // Ignored rather than disabling the radios, which would drop keyboard
    // focus on every pick.
    if (fontSaving) return;
    const key = next === DEFAULT_FONT_KEY ? null : next;
    const field = level === "me" ? "user" : level;
    setFontSaving(true);
    // Optimistic: reflect the pick in the dropdown immediately.
    setFontCfg((prev) => (prev ? { ...prev, [field]: key } : prev));
    try {
      const res =
        level === "me"
          ? await putMyFont(key)
          : level === "org"
            ? await putOrgFont(key)
            : await putPlatformFont(key);
      cacheFontKey(res.resolved);
      applyPlatformFont(res.resolved);
      refreshFonts(); // re-sync all levels + capabilities
    } catch {
      refreshFonts(); // fall back to server truth
    } finally {
      setFontSaving(false);
    }
  };

  return (
    <section className="settings-card">
      <h2 className="settings-card-title">Text</h2>
      <TextSizeTabs />
      {fontCfg && (
        <div className="theme-ui-fonts">
          <FontTiles
            id="ui-font-me"
            label="Your font"
            note="Just for you — overrides your organization & the platform default."
            value={fontCfg.user}
            onChange={(next) => void setFont("me", next)}
          />
          {fontCfg.can_set_org && (
            <FontTiles
              id="ui-font-org"
              label="Organization font"
              note="For all members who haven't set their own font."
              value={fontCfg.org}
              onChange={(next) => void setFont("org", next)}
            />
          )}
          {fontCfg.can_set_platform && (
            <FontTiles
              id="ui-font-platform"
              label="Platform font (default)"
              note="The default for everyone on the platform."
              value={fontCfg.platform}
              onChange={(next) => void setFont("platform", next)}
            />
          )}
        </div>
      )}
    </section>
  );
}
