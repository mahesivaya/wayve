import type { CapacitorConfig } from "@capacitor/cli";

// Trial shell: loads the live site, like the desktop app. Not for App Store
// release, which needs the frontend bundled from webDir instead of server.url.
const config: CapacitorConfig = {
  appId: "com.fluxze.app",
  appName: "Fluxze",
  webDir: "dist",
  // Skips the marketing home page; /login sends signed-in users to their home.
  server: { url: "https://fluxze.com/login" },
  // Keeps the page below the status bar and notch.
  ios: { contentInset: "always" },
};

export default config;
