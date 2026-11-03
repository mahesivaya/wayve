import { useEffect, useRef, useState } from "react";

type BuildKey = "mac-arm64" | "mac-x64";

// Installers are hosted on S3 (public-read, Content-Disposition: attachment so
// they download cross-origin). Shipping a new build is a re-upload to this
// bucket; no frontend redeploy needed.
const S3 = "https://fluxze-desktop-downloads.s3.us-east-1.amazonaws.com";

const BUILDS: Record<BuildKey, { href: string; label: string; sub: string }> = {
  "mac-arm64": {
    // The original Fluxze-arm64/x64.dmg objects are write-locked on S3, so
    // current builds publish under these keys instead.
    href: `${S3}/Fluxze-mac-arm64.dmg`,
    label: "macOS",
    sub: "Apple Silicon",
  },
  "mac-x64": {
    href: `${S3}/Fluxze-mac-x64.dmg`,
    label: "macOS",
    sub: "Intel",
  },
};

const ORDER: BuildKey[] = ["mac-arm64", "mac-x64"];

function AppleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.37 1.43c0 1.06-.39 2.05-1.05 2.79-.78.88-2.06 1.56-3.11 1.47-.13-1.03.4-2.12 1.01-2.8.72-.81 1.98-1.4 3.15-1.46zM20.6 17.02c-.58 1.34-.86 1.94-1.61 3.12-1.05 1.66-2.53 3.72-4.37 3.74-1.63.02-2.05-1.06-4.26-1.05-2.21.01-2.67 1.07-4.3 1.05-1.83-.02-3.24-1.86-4.29-3.52C-1.34 17.16-.04 11.95 2.92 10.17c1.31-.79 2.68-1.08 3.8-1.08 1.63 0 2.65 1.08 4.27 1.08 1.55 0 2.5-1.08 4.27-1.08 1 0 2.6.32 3.8 1.45-3.34 1.83-2.8 6.58.54 7.48z" />
    </svg>
  );
}

function isMac(): boolean {
  return (
    /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform || "")
  );
}

// Mac arch is undetectable from the UA (Apple reports "Intel" on all Macs), so
// use UA-CH on Chromium then a WebGL-renderer heuristic, defaulting to arm64.
async function detectMacArch(): Promise<"mac-arm64" | "mac-x64"> {
  const uaData = (
    navigator as unknown as {
      userAgentData?: {
        getHighEntropyValues?: (
          h: string[]
        ) => Promise<{ architecture?: string }>;
      };
    }
  ).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const { architecture } = await uaData.getHighEntropyValues([
        "architecture",
      ]);
      if (architecture === "arm") return "mac-arm64";
      if (architecture === "x86") return "mac-x64";
    } catch {
      /* fall through */
    }
  }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl!.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "";
    if (/apple/i.test(renderer)) return "mac-arm64";
    if (/intel|amd|radeon|nvidia/i.test(renderer)) return "mac-x64";
  } catch {
    /* ignore */
  }
  return "mac-arm64";
}

export default function DownloadApp() {
  // Stays null off a Mac, so no build is marked as the visitor's own.
  const [primary, setPrimary] = useState<BuildKey | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let alive = true;
    if (isMac()) {
      void detectMacArch().then((k) => {
        if (alive) setPrimary(k);
      });
    }
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <span className="hx-download" ref={ref}>
      <button
        type="button"
        className="hx-btn-ghost hx-download-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">↓</span> Download App
        <span className="hx-download-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="hx-download-menu" role="menu">
          <p className="hx-download-menu-head">Choose your platform</p>
          {ORDER.map((k) => {
            const b = BUILDS[k];
            return (
              <a
                key={k}
                role="menuitem"
                className={`hx-download-item ${k === primary ? "is-detected" : ""}`}
                href={b.href}
                download
                onClick={() => setOpen(false)}
              >
                <span className="hx-download-ico">
                  <AppleIcon />
                </span>
                <span className="hx-download-text">
                  <strong>{b.label}</strong>
                  <small>{b.sub}</small>
                </span>
                {k === primary && (
                  <span className="hx-download-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </a>
            );
          })}
        </div>
      )}
    </span>
  );
}
