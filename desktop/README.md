# Fluxze Desktop

A native macOS desktop app for Fluxze. It's a thin [Electron](https://www.electronjs.org/)
shell that loads **https://fluxze.com** directly — so login, Gmail OAuth,
cookies, chat E2E, WebSocket calls, and CORS all work exactly as they do in the
browser. No backend or `frontend/` changes are involved.

## Develop

```bash
cd desktop
npm install
npm start          # opens a window on https://fluxze.com
```

Point the shell at a local web/dev server instead of production:

```bash
FLUXZE_URL=http://localhost:5173 npm start
```

## Build the installer (.dmg)

```bash
npm run dist       # → desktop/dist/Fluxze-<version>.dmg  (arm64 + x64)
```

Open the `.dmg` and drag **Fluxze** into Applications.

### Unsigned-build note (Gatekeeper)

The build is **not code-signed** (no Apple Developer ID). On first launch macOS
will refuse it. Either:

- **Right-click the app → Open**, then confirm, **or**
- `xattr -dr com.apple.quarantine "/Applications/Fluxze.app"`

To ship a signed + notarized build later, set `CSC_LINK` / `CSC_KEY_PASSWORD`
and add `mac.notarize` in `package.json`'s `build` block.

## App icon

`build/icon.icns` is generated from the brand favicon:

```bash
npm run icon       # rebuilds build/icon.icns from frontend/public/favicon.svg
```

Drop a 1024×1024 source in and re-run if you want a custom icon.

## Files

| File          | Purpose                                                              |
|---------------|---------------------------------------------------------------------|
| `main.cjs`    | Main process: window, menu, external-link + media-permission handling, offline fallback. |
| `preload.cjs` | Minimal isolated bridge (exposes `window.fluxzeDesktop`).           |
| `make-icon.cjs` | Generates `build/icon.icns` from the brand favicon.               |
