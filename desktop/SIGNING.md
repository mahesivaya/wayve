# Signing & notarizing the macOS build

Without this, a downloaded Fluxze app shows **"Fluxze is damaged and can't be
opened"** (macOS Gatekeeper blocking an unsigned, quarantined app). To ship a
build that opens with no warnings, the app must be **signed with a Developer ID
Application certificate** and **notarized by Apple**.

The build config is already wired up (`package.json` → `build.mac` +
`afterSign: notarize.cjs` + `build/entitlements.mac.plist`). It is **env-gated**:
without the credentials below, the build still produces an *unsigned* app (the
"damaged" one). With them, it produces a signed + notarized one.

## One-time prerequisites (you do these in your Apple account)

1. **Apple Developer Program** membership ($99/yr) — https://developer.apple.com/programs/
2. **Developer ID Application** certificate:
   - Xcode → Settings → Accounts → your team → **Manage Certificates** → **+** →
     **Developer ID Application**. (Or create it at developer.apple.com → Certificates.)
   - This installs the signing identity into your **login keychain** —
     electron-builder finds it automatically.
   - Confirm it's there: `security find-identity -v -p codesigning`
     (you should see a line like `… "Developer ID Application: <Your Name> (TEAMID)"`).
3. **App-specific password** for notarization:
   - https://appleid.apple.com → Sign-In & Security → **App-Specific Passwords** → generate one.
4. **Team ID** (10 chars): developer.apple.com → Membership.

## Build (on this Mac)

```bash
cd desktop
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist:mac        # signs with the keychain Developer ID + notarizes + staples
```

If the Developer ID cert is **not** in the keychain (e.g. exported as a `.p12`),
instead set `CSC_LINK=/path/to/cert.p12` and `CSC_KEY_PASSWORD=…` before building.

## Verify the result

```bash
# Gatekeeper should now ACCEPT (not "rejected"):
spctl --assess --type execute --verbose dist/mac-arm64/Fluxze.app
# Notarization ticket stapled to the dmg:
xcrun stapler validate dist/Fluxze-0.1.0-arm64.dmg
```

## Publish

Upload the signed dmgs to the S3 keys the download page points at
(`frontend/src/home/DownloadApp.tsx`):

```bash
AWS_PROFILE=claude_ec2 aws s3 cp dist/Fluxze-0.1.0-arm64.dmg \
  s3://fluxze-desktop-downloads/Fluxze-mac-arm64.dmg --content-type application/x-apple-diskimage
AWS_PROFILE=claude_ec2 aws s3 cp dist/Fluxze-0.1.0.dmg \
  s3://fluxze-desktop-downloads/Fluxze-mac-x64.dmg --content-type application/x-apple-diskimage
```

## Windows (later, out of scope for now)

Needs an **Authenticode** code-signing certificate (OV/EV) and a Windows build
environment (can't build on macOS without wine). Best done in CI with a
`windows-latest` runner; the cert goes in as a secret (`CSC_LINK`/`CSC_KEY_PASSWORD`).
