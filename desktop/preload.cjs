// Minimal preload bridge for the thin wrapper. The remote app works without it;
// it tells the web app it's in the desktop shell, and whether this shell hides
// the native title bar. Older installs don't report that, so the web app keeps
// its normal layout for them. Runs in an isolated context (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fluxzeDesktop", {
  isDesktop: true,
  version: process.env.npm_package_version || "0.1.0",
  platform: process.platform,
  titleBarInset: process.platform === "darwin",
});

// The DOM is shared with the page, so a class is all the web app's CSS needs.
ipcRenderer.on("fluxze:fullscreen", (_event, fullScreen) => {
  document.documentElement.classList.toggle("is-fullscreen", fullScreen);
});
