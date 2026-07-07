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
import { applyPlatformFont } from "./theme/platformFonts";

installDevLog();
installErrorReporter();

// Resolve runtime config (API/WS base + platform font) before rendering so the
// first request uses the right origin and the app paints in the platform-chosen
// font (no flash). `loadRuntimeConfig` never rejects — it falls back to
// build-time / same-origin defaults — so the app always boots.
void loadRuntimeConfig().finally(() => {
  applyPlatformFont(runtimeConfig().fontKey);
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
