// electron-builder `afterSign` hook — submit the signed .app to Apple for
// notarization (required so macOS doesn't show "Fluxze is damaged / unidentified
// developer" on a downloaded build).
//
// Env-gated: if the Apple credentials aren't present, it logs and skips, so a
// plain unsigned/ad-hoc local build still completes. Notarization only works
// when the app was first signed with a real "Developer ID Application" identity
// (electron-builder picks that up from the login keychain or CSC_LINK).
//
// Required env vars when you DO want notarization:
//   APPLE_ID                      your Apple Developer account email
//   APPLE_APP_SPECIFIC_PASSWORD   app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                 10-char Team ID (developer.apple.com → Membership)
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "• notarize: SKIPPED — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename; // "Fluxze"
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`• notarize: submitting ${appPath} to Apple (notarytool)…`);

  await notarize({
    tool: "notarytool",
    appBundleId: context.packager.appInfo.id, // com.fluxze.desktop
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("• notarize: accepted by Apple.");
};
