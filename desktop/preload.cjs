// Minimal preload bridge for the thin wrapper. Nothing is required for the
// remote app to work; this only exposes the desktop app version on
// `window.fluxzeDesktop` in case the web app wants to detect/handle the
// desktop shell later. Runs in an isolated context (contextIsolation: true).

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("fluxzeDesktop", {
  isDesktop: true,
  version: process.env.npm_package_version || "0.1.0",
  platform: process.platform,
});
