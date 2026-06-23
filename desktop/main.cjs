// Fluxze desktop — thin Electron wrapper around the production web app.
//
// The window loads https://fluxze.com/login directly (skipping the marketing
// home page), so OAuth redirects, session cookies, WebSockets (chat/call) and
// the backend CORS allowlist all behave exactly as they do in a browser. No
// frontend or backend changes are needed — the web /login route already bounces
// already-authenticated users to their account home.
//
// Override the target with FLUXZE_URL (e.g. FLUXZE_URL=http://localhost:5173
// npm start) to point the shell at a local dev server.

const { app, BrowserWindow, Menu, session, shell } = require("electron");
const path = require("path");

const APP_URL = process.env.FLUXZE_URL || "https://fluxze.com";
// Open straight to the login screen, skipping the marketing home page. The web
// app's /login guard redirects already-authenticated users to their account
// home, so returning users land in the app — not stranded on login.
const START_URL = `${APP_URL.replace(/\/$/, "")}/login`;

// Force the app/menu name to the brand so the macOS app menu reads "Fluxze"
// (and "About/Hide/Quit Fluxze") in dev too — not "Electron"/"fluxze-desktop".
// Packaged builds already get this from build.productName.
app.name = "Fluxze";

// Hosts allowed to navigate inside the window. Everything else (third-party
// links, mailto:, etc.) opens in the user's default browser. Google hosts are
// included so the Gmail OAuth round-trip can complete in-window.
const IN_WINDOW_HOSTS = [
  "fluxze.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  "content.googleapis.com",
];

/** True when `urlString`'s host is fluxze.com, a subdomain, or a Google OAuth host. */
function isInWindowUrl(urlString) {
  let host;
  try {
    host = new URL(urlString).hostname;
  } catch {
    return false;
  }
  // Local dev: when FLUXZE_URL points at a local server, keep localhost
  // navigations in-window (otherwise hard navs like the post-logout redirect
  // escape to the system browser). Harmless in production — nothing there ever
  // navigates to localhost.
  if (host === "localhost" || host === "127.0.0.1") return true;
  return IN_WINDOW_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#ffffff",
    // Standard macOS title bar: the red/yellow/green window controls sit in
    // their own bar ABOVE the web content. "hiddenInset" floats them over the
    // top-left of the page, where they collide with the app's logo/header.
    titleBarStyle: "default",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      spellcheck: true,
      // Enable Chromium's built-in PDF viewer so in-app PDF previews (Drive's
      // blob: <iframe>) render inline. With plugins disabled (Electron's
      // default), the shell downloads PDFs instead of displaying them.
      plugins: true,
    },
  });

  // Avoid a white flash on cold start: reveal only once the first paint is ready.
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Links that target a new window (target=_blank, window.open). Same-origin /
  // OAuth stay in-app; everything else hands off to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInWindowUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Top-level navigations (clicked anchors). Keep the app on its own origin;
  // send anything external out to the browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInWindowUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Offline / unreachable fallback. errorCode -3 is an aborted load (e.g. a
  // redirect superseding the request) — not a real failure, so ignore it.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      mainWindow.loadURL(offlinePage(errorDescription));
    },
  );

  mainWindow.loadURL(START_URL);
}

/** A minimal inline page shown when fluxze.com can't be reached. */
function offlinePage(detail) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Fluxze</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#0e1d40;color:#fff}
  .box{text-align:center;max-width:360px;padding:24px}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#9fb0d0;font-size:13px;line-height:1.5;margin:0 0 20px}
  button{font-size:14px;padding:10px 22px;border:0;border-radius:8px;
    background:#2563eb;color:#fff;cursor:pointer}
  button:hover{background:#1d4ed8}
</style></head><body>
  <div class="box">
    <h1>Can't reach Fluxze</h1>
    <p>Check your internet connection and try again.<br>${detail || ""}</p>
    <button onclick="location.replace(${JSON.stringify(START_URL)})">Retry</button>
  </div>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * "Update" for this thin shell = reload the live web app, bypassing the HTTP
 * cache so the freshly-deployed index.html (and its new hashed assets) is
 * fetched. Covers every frontend/backend deploy without rebuilding the .dmg.
 * (Only changes to the Electron shell itself need a new installer.)
 */
function reloadLatest() {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  win?.webContents.reloadIgnoringCache();
}

/** A fresh menu-item literal each call (don't share one object across menus). */
function checkForUpdatesItem() {
  return {
    label: "Check for Updates…",
    accelerator: "CmdOrCtrl+U",
    click: reloadLatest,
  };
}

/** Native menu so ⌘C/⌘V/⌘A, reload, zoom and window controls work. */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            // Custom app menu so "Check for Updates…" sits under the app name
            // (the conventional macOS spot), alongside the standard items.
            label: app.name,
            submenu: [
              { role: "about" },
              checkForUpdatesItem(),
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // Also in View so it's discoverable and works on non-mac (no app menu).
        checkForUpdatesItem(),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Grant camera/mic (calls), notifications and clipboard reads to fluxze.com;
  // deny everything else.
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowed = ["media", "notifications", "clipboard-read"];
      const ok =
        allowed.includes(permission) &&
        isInWindowUrl(webContents.getURL());
      callback(ok);
    },
  );

  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS apps stay alive until ⌘Q; elsewhere quit when the last window closes.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
