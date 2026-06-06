import { useEffect, useRef, useState } from "react";

type Arch = "arm64" | "x64";

const DOWNLOADS: Record<Arch, { href: string; label: string }> = {
  arm64: { href: "/download/Fluxze-arm64.dmg", label: "Apple Silicon" },
  x64: { href: "/download/Fluxze-x64.dmg", label: "Intel" },
};

// Best-effort Mac architecture detection. The browser UA always reports
// "Intel" on Apple Silicon (Apple does this for web-compat), so we can't UA
// sniff. Instead: UA-CH `architecture` on Chromium, then a WebGL-renderer
// heuristic (Apple GPU => Apple Silicon) which also works in Safari. Defaults
// to arm64 (the vast majority of Macs today) when neither is conclusive — the
// dropdown lets Intel users override.
async function detectMacArch(): Promise<Arch> {
  const uaData = (
    navigator as unknown as {
      userAgentData?: {
        getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }>;
      };
    }
  ).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const { architecture } = await uaData.getHighEntropyValues(["architecture"]);
      if (architecture === "arm") return "arm64";
      if (architecture === "x86") return "x64";
    } catch {
      /* fall through to the WebGL heuristic */
    }
  }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl!.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "";
    if (/apple/i.test(renderer)) return "arm64";
    if (/intel|amd|radeon|nvidia/i.test(renderer)) return "x64";
  } catch {
    /* ignore — fall back to the default below */
  }
  return "arm64";
}

// Hero download control: a single "Download for Mac ▾" button whose caret opens
// a small menu of Apple Silicon / Intel builds, with the auto-detected one
// marked. Keeps the hero clean (no always-visible arch links).
export default function DownloadMac() {
  const [arch, setArch] = useState<Arch>("arm64");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let alive = true;
    void detectMacArch().then((a) => {
      if (alive) setArch(a);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  // Show the detected build first.
  const order: Arch[] = arch === "x64" ? ["x64", "arm64"] : ["arm64", "x64"];

  return (
    <span className="hx-download" ref={ref}>
      <button
        type="button"
        className="hx-btn-ghost hx-download-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">↓</span> Download for Mac
        <span className="hx-download-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="hx-download-menu" role="menu">
          {order.map((a) => (
            <a
              key={a}
              role="menuitem"
              className="hx-download-item"
              href={DOWNLOADS[a].href}
              onClick={() => setOpen(false)}
            >
              <span>{DOWNLOADS[a].label}</span>
              {a === arch && (
                <span className="hx-download-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </a>
          ))}
        </div>
      )}
    </span>
  );
}
