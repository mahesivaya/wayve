# Releasing the Fluxze desktop app

How a change reaches people using the Fluxze desktop app, how the app updates
itself, and how to build, notarize, publish and roll back a release. Written for
whoever cuts a release; it assumes a Mac with this repository and access to the
Apple developer account and the AWS account.

- [1. Two kinds of change](#1-two-kinds-of-change)
- [2. How self-update works](#2-how-self-update-works)
- [3. One-time setup](#3-one-time-setup)
- [4. Deploying the website side](#4-deploying-the-website-side)
- [5. Building and notarizing a release](#5-building-and-notarizing-a-release)
- [6. Publishing a release](#6-publishing-a-release)
- [7. The first self-updating release (0.2.0)](#7-the-first-self-updating-release-020)
- [8. What people see](#8-what-people-see)
- [9. Testing an update before going live](#9-testing-an-update-before-going-live)
- [10. Stopping or undoing a release](#10-stopping-or-undoing-a-release)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Reference](#12-reference)
- [13. Not yet proven](#13-not-yet-proven)

## 1. Two kinds of change

The desktop app is a thin Electron window that loads https://fluxze.com. What
people see in it comes from two places, which ship differently.

| You changed | Lives in | Ships by | People get it |
|---|---|---|---|
| The web app or backend | `frontend/`, `backend/` | A normal production deploy | When the app next loads a page, or with **Check for Updates** (`Cmd + U`). No install. |
| The window itself: menus, the cancel button on Google pages, which sites stay in the window, the updater | `desktop/` | A new signed and notarized build, uploaded to S3 | Through self-update (section 8). Installs from before 0.2.0 need one manual download. |

Most changes are the first kind. Only follow sections 5–6 when something under
`desktop/` changed.

## 2. How self-update works

Self-update uses [`electron-updater`](https://www.electron.build/auto-update),
which on macOS hands the install to Squirrel.Mac and its helper, ShipIt.

```
 S3 bucket fluxze-desktop-downloads
   latest-mac.yml  ──── lists the newest version and its zips
   Fluxze-<v>-arm64-mac.zip (+ .blockmap)
   Fluxze-<v>-mac.zip       (+ .blockmap)
          │
          │ 1. on launch, every 4 hours, and on Cmd+U
          ▼
 desktop/main.cjs (electron-updater)
   2. newer version? download the zip for this Mac's chip, in the background
   3. "update-downloaded" ──► sends fluxze:update-ready to the page
          │
          ▼
 desktop/preload.cjs  (window.fluxzeDesktop.update)
          │
          ▼
 frontend DesktopUpdateBanner ── "Update ready"  [Restart to update] [Later]
          │ Restart                                   │ Later
          ▼                                           ▼
 4. quitAndInstall: ShipIt swaps the app,       installs the next time
    then reopens it on the new version           the app quits
```

The pieces:

| Piece | File | Job |
|---|---|---|
| Feed location | `desktop/package.json` → `build.publish` | Baked into each build as `Contents/Resources/app-update.yml`. Points at the S3 bucket. |
| Updater | `desktop/main.cjs` → `setUpAutoUpdate` | Checks on launch and every 4 hours, and when **Check for Updates** is chosen. Downloads automatically, installs on quit by default. Only runs in a packaged Mac build. |
| Bridge | `desktop/preload.cjs` → `fluxzeDesktop.update` | `getReadyVersion()`, `onReady(listener)`, `install()`. Also reports the app's real version. |
| Banner | `frontend/src/components/DesktopUpdateBanner.tsx` | Shows the prompt inside the app. Renders nothing in a normal browser. |
| Older installs | `SELF_UPDATING_BUILD_PUBLISHED` in `frontend/src/utils/desktop.ts` | Shows a one-time download prompt to installs that can't update themselves. |
| Feed merger | `desktop/merge-update-feed.cjs` | Combines the Apple Silicon and Intel feeds into one `latest-mac.yml`. |

Things worth knowing:

- **Only a higher version updates.** The app compares `version` in
  `desktop/package.json` of the running app with `latest-mac.yml`.
- **Only the app's own pages can install.** Google's sign-in pages load in the
  same window with the same bridge, so `main.cjs` refuses an install request
  from any page that isn't fluxze.com (or localhost in development).
- **The update must be signed by the same Developer ID.** Squirrel.Mac rejects an
  update whose signature doesn't match the running app.
- **Downloads can be partial.** If the previous version's `.blockmap` is still on
  S3, the app downloads only the changed blocks; otherwise it downloads the whole
  zip. Keep old zips and blockmaps on S3 for this.
- **Uploading `latest-mac.yml` is what releases.** Until it changes, no app is
  offered anything, whatever else is in the bucket.

## 3. One-time setup

Do this once per Mac that cuts releases.

1. **Developer ID certificate** in the login keychain. Check with
   `security find-identity -v -p codesigning`; it should list
   `Developer ID Application: Maheswara Rao Gunturi (XTFKA6B688)`. To set it up
   from scratch, see `SIGNING.md`.
2. **Notarization credentials** stored as the keychain profile `fluxze-notary`:
   ```bash
   xcrun notarytool store-credentials fluxze-notary \
     --apple-id <apple id email> --team-id XTFKA6B688
   ```
   It asks for an app-specific password from https://appleid.apple.com.
   Check with `xcrun notarytool history --keychain-profile fluxze-notary`.
3. **AWS CLI** signed in as a user that can write to the
   `fluxze-desktop-downloads` bucket (region `us-east-1`).
   Check with `aws s3 ls s3://fluxze-desktop-downloads/`.
4. **Dependencies:** `cd desktop && npm ci`.

## 4. Deploying the website side

The banner is part of the web app, so it ships with a normal deploy. You need
this once for the banner to exist, and again whenever `frontend/` changes (for
example to switch on the older-install prompt in section 7).

1. Merge the change into `main`. The `build-images` GitHub Action builds the
   backend and frontend images and pushes them to ECR, tagged with the commit.
2. When that run is green, deploy:
   ```bash
   ./scripts/deploy.sh
   ```
   It aborts if the images for the commit aren't in ECR yet; wait for CI and run
   it again. `BUILD_ON_HOST=1 ./scripts/deploy.sh` builds on the server instead,
   if CI is unavailable.
3. Check it: `curl https://fluxze.com/api/health` should return
   `{"status":"ok"}`.

The banner change needs no database migration. If a deploy does, back up and
apply it first; see the production deploy runbook.

## 5. Building and notarizing a release

Run everything from `desktop/`. Do steps 2–6 twice, once with `arm64` (Apple
Silicon) and once with `x64` (Intel). Notarization takes minutes to hours, so
submitting both before waiting saves time.

| Arch | App folder | Release zip | DMG |
|---|---|---|---|
| `arm64` | `dist/mac-arm64/Fluxze.app` | `Fluxze-<v>-arm64-mac.zip` | `Fluxze-<v>-arm64.dmg` |
| `x64` | `dist/mac/Fluxze.app` | `Fluxze-<v>-mac.zip` (check `dist/`) | `Fluxze-<v>.dmg` |

### Step 1. Bump the version

Set `version` in `desktop/package.json` above the version currently live (look
at `version:` in the live `latest-mac.yml`). Use `0.2.1` for a fix and `0.3.0`
for a feature. Commit it with the change.

### Step 2. Build and sign the app

```bash
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
npx electron-builder --mac zip --arm64 --publish never
```

- Leaving `APPLE_*` unset skips the built-in notarize hook. Notarizing by hand
  (step 3) has proven more reliable.
- **Use `--mac zip`, never `--mac dir`.** A `dir` build leaves out
  `app-update.yml`, and an app without it never finds an update; a later
  `--prepackaged` build can't add it.
- Check it:
  ```bash
  cat dist/mac-arm64/Fluxze.app/Contents/Resources/app-update.yml   # must exist
  codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Fluxze.app
  ```

### Step 3. Submit it for notarization

```bash
ditto -c -k --keepParent dist/mac-arm64/Fluxze.app /tmp/Fluxze-arm64-notarize.zip
xcrun notarytool submit /tmp/Fluxze-arm64-notarize.zip \
  --keychain-profile fluxze-notary --no-s3-acceleration
```

- Only trust the submission if it printed **"Successfully uploaded file"**. Write
  down the submission id.
- Don't add `--wait`; check on it instead (step 4).
- If the upload crashes or hangs, submit again; an interrupted upload has left a
  submission stuck In Progress until Apple dropped it about 12 hours later.

### Step 4. Wait for Apple

```bash
xcrun notarytool info <submission id> --keychain-profile fluxze-notary
```

Wait for `status: Accepted`. If it says `Invalid`, read why:

```bash
xcrun notarytool log <submission id> --keychain-profile fluxze-notary
```

### Step 5. Staple the ticket to the app

```bash
xcrun stapler staple dist/mac-arm64/Fluxze.app
xcrun stapler validate dist/mac-arm64/Fluxze.app
spctl --assess --type execute -vv dist/mac-arm64/Fluxze.app   # "accepted", "Notarized Developer ID"
```

### Step 6. Make the DMG and the release zip from the notarized app

```bash
npx electron-builder --mac dmg zip --arm64 \
  --prepackaged dist/mac-arm64/Fluxze.app --publish never
mv dist/latest-mac.yml dist/latest-mac-arm64.yml
```

Rename the feed straight away: the next arch's build overwrites
`dist/latest-mac.yml`. Then check that `dist/latest-mac-arm64.yml` names the new
version and the zip you just made.

Now repeat steps 2–6 with `x64` and `dist/mac/Fluxze.app`.

### Step 7. Combine the feeds

```bash
node merge-update-feed.cjs dist/latest-mac-arm64.yml dist/latest-mac-x64.yml > dist/latest-mac.yml
cat dist/latest-mac.yml
```

It refuses feeds with different versions. The result lists both zips; each Mac
picks the one for its chip (a file whose name contains `arm64`, or the other).

Check each zip matches its entry:

```bash
openssl dgst -sha512 -binary dist/Fluxze-<v>-arm64-mac.zip | base64   # equals its sha512 in the feed
```

## 6. Publishing a release

```bash
B=s3://fluxze-desktop-downloads
URL=https://fluxze-desktop-downloads.s3.us-east-1.amazonaws.com
V=<version>
```

### Step 1. Keep the current feed for rollback

```bash
aws s3 cp $B/latest-mac.yml dist/latest-mac.previous.yml
```

It doesn't exist before the first self-updating release; that's fine.

### Step 2. Upload the update zips and blockmaps

```bash
aws s3 cp dist/Fluxze-$V-arm64-mac.zip          $B/ --content-type application/zip
aws s3 cp dist/Fluxze-$V-arm64-mac.zip.blockmap $B/ --content-type application/octet-stream
aws s3 cp dist/Fluxze-$V-mac.zip                $B/ --content-type application/zip
aws s3 cp dist/Fluxze-$V-mac.zip.blockmap       $B/ --content-type application/octet-stream
```

Keep their built names: `latest-mac.yml` refers to them by name. Don't delete
older zips and blockmaps; they make the next update a partial download.

### Step 3. Upload the installers for new people

```bash
aws s3 cp dist/Fluxze-$V-arm64.dmg $B/Fluxze-mac-arm64.dmg --content-type application/x-apple-diskimage
aws s3 cp dist/Fluxze-$V.dmg       $B/Fluxze-mac-x64.dmg   --content-type application/x-apple-diskimage
```

These two names are what the website's **Download App** links point to. The
older `Fluxze-arm64.dmg` and `Fluxze-x64.dmg` objects are write-locked; leave them.

### Step 4. Check every upload through its public URL

```bash
for f in Fluxze-$V-arm64-mac.zip Fluxze-$V-arm64-mac.zip.blockmap \
         Fluxze-$V-mac.zip Fluxze-$V-mac.zip.blockmap \
         Fluxze-mac-arm64.dmg Fluxze-mac-x64.dmg; do
  printf '%s ' "$f"; curl -sI "$URL/$f" | head -1
done
```

Every line must be `200`. A quiet `aws s3 cp` once printed nothing and changed
nothing, so don't skip this. If a file is `403`, the bucket isn't making new
objects public; fix that before going on.

### Step 5. Install it yourself

Download a DMG from its public URL in a browser, install it over your copy, open
it and log in. **Fluxze → About Fluxze** should show the new version. This is
the last check before everyone gets it.

### Step 6. Go live: upload the feed

```bash
aws s3 cp dist/latest-mac.yml $B/latest-mac.yml --content-type text/yaml --cache-control no-cache
curl -s "$URL/latest-mac.yml"
```

From here, every running copy finds the update within 4 hours, at its next
launch, or straight away with `Cmd + U`.

### Step 7. Watch it arrive

On a Mac with the previous version installed, press `Cmd + U`. The **Update
ready** banner should appear within a minute or two; click **Restart to update**
and check **About Fluxze** afterwards.

## 7. The first self-updating release (0.2.0)

Installs from before 0.2.0 have no updater, so this release is different once.

1. **Deploy the website** with the banner (section 4). Nobody sees anything yet:
   the older-install prompt is off and no update is published.
2. **Build, notarize and publish 0.2.0** (sections 5 and 6). `latest-mac.yml`
   doesn't exist yet, so step 1 of section 6 has nothing to keep.
3. **Install it yourself** from the website's Download App link and check it.
4. **Turn on the prompt for older installs.** In
   `frontend/src/utils/desktop.ts` set:
   ```ts
   export const SELF_UPDATING_BUILD_PUBLISHED = true;
   ```
   Commit, merge and deploy (section 4). Never do this before 0.2.0 is on S3,
   or the prompt sends people the installer they already have.
5. People on 0.1.0 now see **Update available** with **Apple Silicon** and
   **Intel** buttons. Each opens the DMG in their browser; they drag Fluxze into
   Applications, replacing the old one. From then on, updates are automatic.

## 8. What people see

| Situation | What appears |
|---|---|
| Up to date | Nothing |
| A newer version is downloading | Nothing; it downloads in the background |
| The newer version is ready | **Update ready** card, bottom right: "A new version of Fluxze is ready to install." with **Restart to update** and **Later** |
| They click **Restart to update** | The button reads **Restarting…**, the app closes, installs, and reopens on the new version within seconds |
| They click **Later** | The card hides until the app next starts; the update installs when they quit |
| Another, newer version arrives after **Later** | The card comes back |
| They're on a version from before 0.2.0, and the prompt is on | **Update available** card with download buttons, until they install 0.2.0 |
| fluxze.com in a normal browser | Nothing, ever |

The card is inside the app window, not a macOS notification, so it shows only
while the app is open. The app checks on launch, every 4 hours, and on
**Check for Updates** (`Cmd + U`, also in the Fluxze and View menus).

## 9. Testing an update before going live

You can rehearse a full update on your own Mac without touching S3, by building
two versions that read their feed from your machine. This is how the updater was
tested.

```bash
cd desktop
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID ELECTRON_RUN_AS_NODE
for v in 9.0.0 9.0.1; do
  npx electron-builder --mac zip --arm64 --publish never \
    -c.extraMetadata.version=$v \
    -c.publish.provider=generic -c.publish.url=http://localhost:8899 \
    -c.directories.output=/tmp/fluxze-test/$v
done
ditto /tmp/fluxze-test/9.0.0/mac-arm64/Fluxze.app /tmp/fluxze-test/run/Fluxze.app
(cd /tmp/fluxze-test/9.0.1 && python3 -m http.server 8899) &
FLUXZE_URL=http://localhost /tmp/fluxze-test/run/Fluxze.app/Contents/MacOS/Fluxze
```

The app starts as 9.0.0, finds 9.0.1, and shows **Update ready**. Click **Restart
to update**; it reopens as 9.0.1. Afterwards stop the server and delete
`/tmp/fluxze-test`, `~/Library/Caches/fluxze-desktop-updater` and
`~/Library/Caches/com.fluxze.desktop.ShipIt`.

- The builds are signed but not notarized, which is fine on the Mac that built
  them.
- `FLUXZE_URL=http://localhost` loads your local stack, so the banner code must
  be in it. Without `FLUXZE_URL` it loads fluxze.com, which only has the banner
  once deployed.
- When it reopens after updating, ShipIt starts it without `FLUXZE_URL`, so it
  loads fluxze.com.
- Don't click in the test window while a script drives it: a click on **Restart
  to update** makes a test look like the app quit by itself.

## 10. Stopping or undoing a release

**Stop a rollout** that isn't finished, so copies that haven't updated aren't
offered it:

```bash
aws s3 cp dist/latest-mac.previous.yml s3://fluxze-desktop-downloads/latest-mac.yml \
  --content-type text/yaml --cache-control no-cache
```

Also put the previous DMGs back under `Fluxze-mac-arm64.dmg` and
`Fluxze-mac-x64.dmg` if the new ones are bad.

**Copies that already updated stay on it.** The updater never moves to a lower
version. Fix forward: release a higher version (for example `0.2.2`) with the fix.

**Copies that downloaded but haven't restarted** install it when they quit. They
can't be called back; the fix-forward release replaces it.

A bad website deploy is rolled back like any other deploy, by deploying the
previous commit; no desktop release is involved.

## 11. Troubleshooting

To see what the updater is doing, quit Fluxze and start it from Terminal:

```bash
/Applications/Fluxze.app/Contents/MacOS/Fluxze
```

It prints `Checking for update`, `Found version …`, `Downloading update …` and
any error. ShipIt, which does the install, logs to
`~/Library/Caches/com.fluxze.desktop.ShipIt/ShipIt_stderr.log`. Downloads wait
in `~/Library/Caches/fluxze-desktop-updater/pending/`.

| Symptom | Likely cause | What to do |
|---|---|---|
| Stays at `Checking for update` forever | No `app-update.yml` in the app: it was built with `--mac dir` | Rebuild with `--mac zip` (section 5, step 2) |
| `Cannot find channel "latest-mac.yml"` (404) | The feed isn't uploaded, or isn't public | Check `curl -sI $URL/latest-mac.yml` |
| Finds nothing although you uploaded a release | Its version isn't higher, or a cached feed | Check `version:` in the live feed; upload it with `--cache-control no-cache` |
| Error about the code signature, or the update is rejected | The update was signed with a different identity, or not signed | Build on the Mac with the Developer ID certificate; check with `codesign --verify` |
| Install fails | The app is running from the DMG, or from a folder the user can't write to | Move Fluxze into Applications |
| The banner never shows, but the log says it downloaded | The installed app is from before 0.2.0, or the website without the banner is deployed | Check **About Fluxze**; deploy the website (section 4) |
| `Cannot download differentially, fallback to full download` | The previous version's blockmap isn't on S3 | Harmless; keep zips and blockmaps on S3 from now on |
| macOS says Fluxze "is damaged" after downloading the DMG | The app wasn't notarized or stapled | Section 5, steps 3–5 |
| Notarization submission vanished, or stays In Progress | An interrupted upload | Submit again with `--no-s3-acceleration`; trust only "Successfully uploaded file" |

## 12. Reference

**Public URLs** (base `https://fluxze-desktop-downloads.s3.us-east-1.amazonaws.com`):

| File | Purpose |
|---|---|
| `latest-mac.yml` | The update feed; uploading it releases |
| `Fluxze-<v>-arm64-mac.zip`, `.blockmap` | Apple Silicon update |
| `Fluxze-<v>-mac.zip`, `.blockmap` | Intel update |
| `Fluxze-mac-arm64.dmg`, `Fluxze-mac-x64.dmg` | Installers behind the website's Download App links |

**Accounts:** Apple team `XTFKA6B688`, keychain profile `fluxze-notary`. AWS
account `339713009139`, bucket `fluxze-desktop-downloads`, region `us-east-1`.

**Release checklist**

- [ ] `version` bumped in `desktop/package.json` and committed
- [ ] For `arm64` and `x64`: built with `--mac zip`, `app-update.yml` present,
      notarized ("Successfully uploaded file", then Accepted), stapled,
      `--prepackaged` DMG and zip made, feed renamed
- [ ] Feeds merged; zip hashes match
- [ ] Previous `latest-mac.yml` saved
- [ ] Zips, blockmaps and DMGs uploaded, each `200` through its public URL
- [ ] Installed from the public DMG and checked **About Fluxze**
- [ ] `latest-mac.yml` uploaded last, with `--cache-control no-cache`
- [ ] Watched an older copy update with `Cmd + U`
- [ ] First release only: `SELF_UPDATING_BUILD_PUBLISHED = true` deployed

## 13. Not yet proven

As of 0.2.0 (November 2026), the updater has been tested end to end only with
locally signed Apple Silicon builds and a feed on localhost (section 9). Not yet
exercised:

- The notarize-then-`--prepackaged` path in section 5, and whether its
  `latest-mac.yml` comes out as expected.
- An Intel Mac updating.
- An update served from S3, including whether new uploads are public by default.
- The **Update available** prompt on a real 0.1.0 install.

Check each of these on the 0.2.0 release, and update this section afterwards.
