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

## Updates

Web app changes need nothing here: a deploy reaches the app on its next load. A
change to the shell itself updates through `electron-updater`. The app checks the
feed on launch and every 4 hours, downloads a newer build in the background, and
the web app shows "Restart to update"; otherwise it installs on quit.

To release, bump `version` in `package.json`, then for each of `arm64` and `x64`:

1. `electron-builder --mac zip --<arch>` with `APPLE_*` unset. Not `--mac dir`: a
   `dir` build leaves out `app-update.yml`, and an app without it never updates.
2. Notarize the app and staple it.
3. `electron-builder --mac dmg zip --<arch> --prepackaged <app> --publish never`.
4. `mv dist/latest-mac.yml dist/latest-mac-<arch>.yml`, as the next arch overwrites it.

Then combine the two feeds and upload to the `fluxze-desktop-downloads` bucket:

```bash
node merge-update-feed.cjs dist/latest-mac-arm64.yml dist/latest-mac-x64.yml > dist/latest-mac.yml
```

Upload each arch's DMG as `Fluxze-mac-<arch>.dmg`, plus both `.zip` and
`.zip.blockmap` files under their built names. **Upload `latest-mac.yml` last, with
`--cache-control no-cache`**: that upload is what starts the rollout, so test the
build first. Installs from before 0.2.0 can't update themselves and need the DMG
once; set `SELF_UPDATING_BUILD_PUBLISHED` in `frontend/src/utils/desktop.ts` after
publishing it, which shows those installs a download prompt.

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
| `merge-update-feed.cjs` | Combines each arch's update feed into the one `latest-mac.yml`. |
| `make-icon.cjs` | Generates `build/icon.icns` from the brand favicon.               |
