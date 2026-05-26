import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { installDevLog } from "./utils/devlog";
import { loadRuntimeConfig } from "./config/runtimeConfig";

installDevLog();

// Resolve runtime config (API/WS base) before rendering so the first request
// uses the right origin. `loadRuntimeConfig` never rejects — it falls back to
// build-time / same-origin defaults — so the app always boots.
void loadRuntimeConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  );
});