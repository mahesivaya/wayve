// Minimal preload bridge for the thin wrapper. The remote app works without it;
// it tells the web app it's in the desktop shell, and whether this shell hides
// the native title bar. Older installs don't report that, so the web app keeps
// its normal layout for them. Runs in an isolated context (contextIsolation: true).

const { contextBridge, ipcRenderer } = require("electron");

const versionArg = process.argv.find((arg) =>
  arg.startsWith("--fluxze-version="),
);

contextBridge.exposeInMainWorld("fluxzeDesktop", {
  isDesktop: true,
  version: versionArg?.split("=")[1] ?? "0.0.0",
  platform: process.platform,
  titleBarInset: process.platform === "darwin",
  // A newer shell has downloaded and is waiting for a restart. Absent on older
  // installs, which can't update themselves.
  update: {
    getReadyVersion: () => ipcRenderer.invoke("fluxze:get-ready-update"),
    onReady: (listener) => {
      const handler = (_event, version) => listener(version);
      ipcRenderer.on("fluxze:update-ready", handler);
      return () => ipcRenderer.removeListener("fluxze:update-ready", handler);
    },
    install: () => ipcRenderer.invoke("fluxze:install-update"),
  },
});

// The DOM is shared with the page, so a class is all the web app's CSS needs.
ipcRenderer.on("fluxze:fullscreen", (_event, fullScreen) => {
  document.documentElement.classList.toggle("is-fullscreen", fullScreen);
});
