import { apiFetchJson } from "./client";

// The UI font resolves per scope, preferring a user's own font, then their
// organization's, then the platform default. `theme/platformFonts.ts` maps each
// key to a stack. Pre-login clients get only the platform value, from
// GET /api/config at boot; signed-in clients call getFontConfig for the fully
// resolved font plus each level's value for the editor.
export type FontConfig = {
  resolved: string | null;
  user: string | null;
  org: string | null;
  platform: string | null;
  can_set_org: boolean;
  can_set_platform: boolean;
};

export const getFontConfig = () => apiFetchJson<FontConfig>("/api/ui/font");

// Each setter takes a font key, where null or "system" clears that level so it
// inherits the next one, and returns the caller's newly-resolved font.
export const putMyFont = (fontKey: string | null) =>
  apiFetchJson<{ user: string | null; resolved: string | null }>(
    "/api/ui/font/me",
    { method: "PUT", body: JSON.stringify({ font_key: fontKey }) }
  );

export const putOrgFont = (fontKey: string | null) =>
  apiFetchJson<{ org: string | null; resolved: string | null }>(
    "/api/ui/font/org",
    { method: "PUT", body: JSON.stringify({ font_key: fontKey }) }
  );

// Platform owner only.
export const putPlatformFont = (fontKey: string | null) =>
  apiFetchJson<{ platform: string | null; resolved: string | null }>(
    "/api/platform/ui-config",
    { method: "PUT", body: JSON.stringify({ font_key: fontKey }) }
  );
