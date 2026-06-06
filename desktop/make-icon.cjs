// Generate build/icon.icns for the macOS app from the frontend brand favicon.
//
// The source (frontend/public/favicon.svg) is a wide 1536x1024 logo, so we
// rasterize it with qlmanage, pad it to a centered 1024x1024 square on the
// brand background colour with sips, fan it out into an .iconset at every
// required size, and pack it with iconutil. If rasterization fails for any
// reason, we fall back to a solid brand-colour square so the build still works.
//
// Run with: npm run icon   (re-run whenever the brand logo changes)

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BRAND_BG = "ECF7FD"; // matches the favicon background fill
const SRC_SVG = path.resolve(
  __dirname,
  "../frontend/public/favicon.svg",
);
const BUILD_DIR = path.join(__dirname, "build");
const ICONSET = path.join(BUILD_DIR, "icon.iconset");
const ICNS = path.join(BUILD_DIR, "icon.icns");

// (size in px, iconset filename) — the standard macOS icon matrix.
const SIZES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "pipe" });
}

function ensureCleanDirs() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
}

// Produce a 1024x1024 square master PNG at `out`. Tries the real logo first,
// falls back to a solid brand square.
function makeMaster(out, tmp) {
  try {
    if (!fs.existsSync(SRC_SVG)) throw new Error(`missing ${SRC_SVG}`);
    // qlmanage writes "<basename>.png" into the output dir.
    run("qlmanage", ["-t", "-s", "1024", "-o", tmp, SRC_SVG]);
    const raster = path.join(tmp, path.basename(SRC_SVG) + ".png");
    if (!fs.existsSync(raster)) throw new Error("qlmanage produced no png");
    // Pad the wide logo to a centered 1024x1024 square on the brand colour.
    run("sips", [
      "--padToHeightWidth",
      "1024",
      "1024",
      "--padColor",
      BRAND_BG,
      raster,
      "--out",
      out,
    ]);
    console.log("icon: rasterized from", path.relative(process.cwd(), SRC_SVG));
  } catch (err) {
    console.warn("icon: logo rasterization failed, using solid fallback:", err.message);
    // Fallback: a 1x1 brand-colour PNG scaled up to 1024 by sips.
    const onePx = path.join(tmp, "px.png");
    // Minimal 1x1 PNG (#ECF7FD-ish) — sips recolours via pad anyway.
    run("sips", [
      "-s",
      "format",
      "png",
      "--resampleHeightWidth",
      "1024",
      "1024",
      "--padColor",
      BRAND_BG,
      blankPng(onePx),
      "--out",
      out,
    ]);
  }
}

// Write a tiny blank PNG and return its path (used only by the fallback path).
function blankPng(p) {
  // 1x1 transparent PNG.
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  fs.writeFileSync(p, Buffer.from(b64, "base64"));
  return p;
}

function main() {
  ensureCleanDirs();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fluxze-icon-"));
  const master = path.join(tmp, "master.png");
  makeMaster(master, tmp);

  for (const [size, name] of SIZES) {
    run("sips", [
      "-z",
      String(size),
      String(size),
      master,
      "--out",
      path.join(ICONSET, name),
    ]);
  }

  run("iconutil", ["-c", "icns", ICONSET, "-o", ICNS]);
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("icon: wrote", path.relative(process.cwd(), ICNS));
}

main();
