// A dotted matrix of OKLCH samples: click a dot to get a theme in its color, or
// drag the marker. The ~1200 dots are SVG circles rather than divs: inline-styled
// divs are sluggish to update at that count, and preserveAspectRatio="none"
// stretches the grid to any width without per-dot math.

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThemeMode } from "./customThemeShared";

interface Props {
  hue: number;
  chroma: number;
  mode: ThemeMode;
  onChange: (next: { hue: number; chroma: number; mode: ThemeMode }) => void;
}

const COLS = 60;
const ROWS = 22;
// High enough for a vivid spectrum, low enough that no hue clips out of gamut.
const PREVIEW_C = 0.16;
// Must match the Chroma slider's max, or the grid and slider drift apart.
const CHROMA_MAX = 0.3;
const CHROMA_STEP = 0.01;
// The palest theme a dot gives, so every dot shows some of its color.
const CHROMA_MIN = 0.04;
const HALF = Math.floor(ROWS / 2);
const LAST_DARK_ROW_OFFSET = ROWS - HALF - 1;

interface Dot {
  cx: number;
  cy: number;
  fill: string;
}

// The mid-row split gives the grid two lightness bands: a brighter one on top
// and a darker one below.
const rowLightness = (row: number) =>
  row < HALF ? 0.82 - (row / HALF) * 0.27 : 0.45 - ((row - HALF) / HALF) * 0.23;

const dotColor = (row: number, hue: number) =>
  `oklch(${rowLightness(row).toFixed(3)} ${PREVIEW_C.toFixed(3)} ${hue.toFixed(1)})`;

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const h = (col / COLS) * 360;
      dots.push({
        cx: col + 0.5,
        cy: row + 0.5,
        fill: dotColor(row, h),
      });
    }
  }
  return dots;
}

// Snap to the slider's step so float math can't drift the two out of sync.
const snapChroma = (c: number) =>
  Math.max(0, Math.min(CHROMA_MAX, Math.round(c / CHROMA_STEP) * CHROMA_STEP));

const clampRow = (row: number) => Math.max(0, Math.min(ROWS - 1, row));

// A dot's row sets the theme: the bright band gives a light theme and the dark
// band a dark one, each strongest where the two bands meet.
function themeForRow(row: number): { chroma: number; mode: ThemeMode } {
  const span = CHROMA_MAX - CHROMA_MIN;
  if (row < HALF) {
    return {
      mode: "light",
      chroma: snapChroma(CHROMA_MIN + (row / (HALF - 1)) * span),
    };
  }
  return {
    mode: "dark",
    chroma: snapChroma(
      CHROMA_MAX - ((row - HALF) / LAST_DARK_ROW_OFFSET) * span
    ),
  };
}

function rowForTheme(chroma: number, mode: ThemeMode): number {
  const strength = Math.max(
    0,
    Math.min(1, (chroma - CHROMA_MIN) / (CHROMA_MAX - CHROMA_MIN))
  );
  return mode === "light"
    ? Math.round(strength * (HALF - 1))
    : HALF + Math.round((1 - strength) * LAST_DARK_ROW_OFFSET);
}

const hueForCol = (col: number) => Math.round((col / COLS) * 360);

export default function ColorGrid({ hue, chroma, mode, onChange }: Props) {
  const dots = useMemo(() => buildDots(), []);
  const containerRef = useRef<HTMLDivElement>(null);

  // The marker sits on the dot for the current theme, in that dot's color.
  const markerCol = Math.min(COLS - 1, Math.round((hue / 360) * COLS));
  const markerRow = rowForTheme(chroma, mode);
  const markerXPct = ((markerCol + 0.5) / COLS) * 100;
  const markerYPct = ((markerRow + 0.5) / ROWS) * 100;

  const updateFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onChange({
        hue: hueForCol(Math.min(COLS - 1, Math.floor(px * COLS))),
        ...themeForRow(clampRow(Math.floor(py * ROWS))),
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

  // Keyboard nudges for accessibility: the arrows move one dot.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        onChange({
          hue: hueForCol(Math.max(0, markerCol - 1)),
          chroma,
          mode,
        });
      } else if (e.key === "ArrowRight") {
        onChange({
          hue: hueForCol(Math.min(COLS - 1, markerCol + 1)),
          chroma,
          mode,
        });
      } else if (e.key === "ArrowUp") {
        onChange({ hue, ...themeForRow(clampRow(markerRow - 1)) });
      } else if (e.key === "ArrowDown") {
        onChange({ hue, ...themeForRow(clampRow(markerRow + 1)) });
      } else {
        return;
      }
      e.preventDefault();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [hue, chroma, mode, markerCol, markerRow, onChange]);

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
          background: dotColor(markerRow, hue),
        }}
      />
    </div>
  );
}
