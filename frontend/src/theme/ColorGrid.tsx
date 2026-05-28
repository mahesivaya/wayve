// 2D color grid picker — the macro-style centerpiece of the Custom tab.
//
// Renders a dotted matrix of OKLCH samples (hue varying horizontally,
// lightness varying vertically) with a draggable square marker showing the
// current selection. Click or drag anywhere on the grid to set the hue.
//
// We render dots as SVG <circle>s because there are ~1200 of them and
// inline-styled divs become sluggish to update. SVG also gives us a clean
// preserveAspectRatio="none" stretch so the grid fills any container width
// without per-dot math.

import { useCallback, useEffect, useMemo, useRef } from "react";

interface Props {
  hue: number;
  chroma: number;
  onChange: (next: { hue: number; chroma: number }) => void;
}

const COLS = 60;
const ROWS = 22;
// A fixed chroma for the preview dots — high enough that the spectrum is
// vivid, low enough that low-saturation hues don't out-gamut and clip.
const PREVIEW_C = 0.16;
// Chroma range that the Y axis spans: 0 (top, muted) ↔ CHROMA_MAX (bottom,
// vivid). Matches the slider's max so the grid + slider stay in sync.
const CHROMA_MAX = 0.3;
const CHROMA_STEP = 0.01;

interface Dot {
  cx: number;
  cy: number;
  fill: string;
}

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  for (let row = 0; row < ROWS; row++) {
    // Top half (row 0..ROWS/2-1): brighter band, dropping from L=0.82 to ~0.55.
    // Bottom half: darker band, dropping from L=0.45 to ~0.22.
    // The mid-row split makes the grid look like macro's two-zone gradient.
    const half = Math.floor(ROWS / 2);
    const l = row < half
      ? 0.82 - (row / half) * 0.27
      : 0.45 - ((row - half) / half) * 0.23;
    for (let col = 0; col < COLS; col++) {
      const h = (col / COLS) * 360;
      dots.push({
        cx: col + 0.5,
        cy: row + 0.5,
        fill: `oklch(${l.toFixed(3)} ${PREVIEW_C.toFixed(3)} ${h.toFixed(1)})`,
      });
    }
  }
  return dots;
}

// Round chroma to the slider's step (0.01) so the grid + slider don't drift
// out of sync from float math.
const snapChroma = (c: number) =>
  Math.max(0, Math.min(CHROMA_MAX, Math.round(c / CHROMA_STEP) * CHROMA_STEP));

export default function ColorGrid({ hue, chroma, onChange }: Props) {
  const dots = useMemo(() => buildDots(), []);
  const containerRef = useRef<HTMLDivElement>(null);

  // X drives hue (0..360), Y drives chroma (0..CHROMA_MAX). Top of grid =
  // muted (low chroma); bottom = vivid (high chroma). The marker reflects
  // both axes so the user can see exactly where they are in the color
  // space — fine-tuning is still available via the Chroma slider below.
  const markerCol = (hue / 360) * COLS;
  const chromaPct = chroma / CHROMA_MAX;
  const markerXPct = (markerCol / COLS) * 100;
  const markerYPct = chromaPct * 100;

  const updateFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onChange({
        hue: Math.round(px * 360),
        chroma: snapChroma(py * CHROMA_MAX),
      });
    },
    [onChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromClient(e.clientX, e.clientY);
    },
    [updateFromClient],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      updateFromClient(e.clientX, e.clientY);
    },
    [updateFromClient],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // Keyboard nudges for accessibility: Left/Right → hue, Up/Down → chroma.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        onChange({ hue: Math.max(0, hue - 5), chroma });
      } else if (e.key === "ArrowRight") {
        onChange({ hue: Math.min(360, hue + 5), chroma });
      } else if (e.key === "ArrowUp") {
        onChange({ hue, chroma: snapChroma(chroma - CHROMA_STEP * 2) });
      } else if (e.key === "ArrowDown") {
        onChange({ hue, chroma: snapChroma(chroma + CHROMA_STEP * 2) });
      } else {
        return;
      }
      e.preventDefault();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [hue, chroma, onChange]);

  return (
    <div
      ref={containerRef}
      className="color-grid"
      role="slider"
      aria-label="Hue and chroma picker"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(hue)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg
        className="color-grid-svg"
        viewBox={`0 0 ${COLS} ${ROWS}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {dots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={0.18} fill={d.fill} />
        ))}
      </svg>
      <div
        className="color-grid-marker"
        style={{
          left: `${markerXPct}%`,
          top: `${markerYPct}%`,
          background: `oklch(0.68 ${chroma.toFixed(3)} ${hue.toFixed(1)})`,
        }}
      />
    </div>
  );
}
