import { apiFetchJson } from "./client";

// UI font, resolved per scope: a user's own font > their organization's > the
// platform default. See `theme/platformFonts.ts` for the key→stack mapping. The
// platform value is also delivered to every client via GET /api/config at boot
// (pre-login / fallback); signed-in clients call getFontConfig for their fully
// resolved font + each level's value for the editor.

// The caller's resolved font plus each level and what they may edit.
export type FontConfig = {
  resolved: string | null;
  user: string | null;
  org: string | null;
  platform: string | null;
  can_set_org: boolean;
  can_set_platform: boolean;
};

export const getFontConfig = () => apiFetchJson<FontConfig>("/api/ui/font");

// Each setter takes a font key; `null` / "system" clears that level (inherit the
// next one). They return the caller's newly-resolved font.
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

// Platform default (platform owner only).
export const putPlatformFont = (fontKey: string | null) =>
  apiFetchJson<{ platform: string | null; resolved: string | null }>(
    "/api/platform/ui-config",
    { method: "PUT", body: JSON.stringify({ font_key: fontKey }) }
  );
