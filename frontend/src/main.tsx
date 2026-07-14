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
import { applyRuntimeClass } from "./utils/desktop";

installDevLog();
installErrorReporter();
// Tags <html> with is-desktop/is-web (+ data-platform) so stylesheets can fork
// between the Electron shell and the browser in pure CSS.
applyRuntimeClass();

// Runtime config (API/WS base + platform font) must resolve before the first
// render so the first request uses the right origin and the app paints without
// a font flash. `loadRuntimeConfig` never rejects, so the app always boots.
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
