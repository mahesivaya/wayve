import { apiFetchJson } from "./client";

// Platform-wide UI settings (platform owner only). Currently just the app-wide
// font key (see `theme/platformFonts.ts` for the key→stack mapping). The public
// value is also delivered to every client via GET /api/config at boot; these
// endpoints are for the owner's editor.
export type PlatformUiConfig = { font_key: string | null };

export const getPlatformUiConfig = () =>
  apiFetchJson<PlatformUiConfig>("/api/platform/ui-config");

// `null` / "system" clears the override (back to the app default).
export const putPlatformUiConfig = (fontKey: string | null) =>
  apiFetchJson<PlatformUiConfig>("/api/platform/ui-config", {
    method: "PUT",
    body: JSON.stringify({ font_key: fontKey }),
  });
