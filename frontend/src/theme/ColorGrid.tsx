// A dotted matrix of OKLCH samples with a draggable marker. The ~1200 dots are
// SVG circles rather than divs: inline-styled divs are sluggish to update at
// that count, and preserveAspectRatio="none" stretches the grid to any width
// without per-dot math.

import { useCallback, useEffect, useMemo, useRef } from "react";

interface Props {
  hue: number;
  chroma: number;
  onChange: (next: { hue: number; chroma: number }) => void;
}

const COLS = 60;
const ROWS = 22;
// High enough for a vivid spectrum, low enough that no hue clips out of gamut.
const PREVIEW_C = 0.16;
// Must match the Chroma slider's max, or the grid and slider drift apart.
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
    // The mid-row split gives the grid two lightness bands: a brighter one on
    // top and a darker one below.
    const half = Math.floor(ROWS / 2);
    const l =
      row < half
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

// Snap to the slider's step so float math can't drift the two out of sync.
const snapChroma = (c: number) =>
  Math.max(0, Math.min(CHROMA_MAX, Math.round(c / CHROMA_STEP) * CHROMA_STEP));

export default function ColorGrid({ hue, chroma, onChange }: Props) {
  const dots = useMemo(() => buildDots(), []);
  const containerRef = useRef<HTMLDivElement>(null);

  // X drives hue; Y drives chroma, muted at the top and vivid at the bottom.
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
    [onChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromClient(e.clientX, e.clientY);
    },
    [updateFromClient]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      updateFromClient(e.clientX, e.clientY);
    },
    [updateFromClient]
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
