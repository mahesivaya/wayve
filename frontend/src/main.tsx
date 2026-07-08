import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { CustomThemeProvider } from "./theme/CustomThemeContext";
import ThemeSyncBridge from "./theme/ThemeSyncBridge";
import { installDevLog } from "./utils/devlog";
import { installErrorReporter } from "./utils/errorReporter";
import { loadRuntimeConfig, runtimeConfig } from "./config/runtimeConfig";
import { applyPlatformFont, cachedFontKey } from "./theme/platformFonts";

installDevLog();
installErrorReporter();

// Resolve runtime config (API/WS base + platform font) before rendering so the
// first request uses the right origin and the app paints in the right font (no
// flash). A returning signed-in user has their resolved font cached locally;
// otherwise fall back to the platform default from /api/config. AuthContext
// refreshes the per-user resolved font once the session is known.
// `loadRuntimeConfig` never rejects, so the app always boots.
void loadRuntimeConfig().finally(() => {
  const cached = cachedFontKey();
  applyPlatformFont(cached !== null ? cached : runtimeConfig().fontKey);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <CustomThemeProvider>
        <AuthProvider>
          <ThemeSyncBridge>
            <App />
          </ThemeSyncBridge>
        </AuthProvider>
      </CustomThemeProvider>
    </BrowserRouter>
  );
});
