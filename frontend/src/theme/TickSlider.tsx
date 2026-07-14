// A div-based slider rather than <input type="range">, which cannot be styled
// consistently across browsers. Keyboard support is therefore hand-rolled: the
// role, aria-value* attributes and arrow-key handler below are what make it
// accessible, so they must stay.

import { useCallback, useRef } from "react";

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  variant: "ticks" | "gradient";
  trackBackground?: string;
  ariaLabel: string;
}

export default function TickSlider({
  value,
  min,
  max,
  step,
  onChange,
  variant,
  trackBackground,
  ariaLabel,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const pct = ((value - min) / (max - min)) * 100;

  const updateFromClientX = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      let next = min + fraction * (max - min);
      if (step) next = Math.round(next / step) * step;
      onChange(next);
    },
    [min, max, step, onChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromClientX(e.clientX);
    },
    [updateFromClientX]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      updateFromClientX(e.clientX);
    },
    [updateFromClientX]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = step ?? (max - min) / 100;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        onChange(Math.max(min, value - delta));
        e.preventDefault();
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        onChange(Math.min(max, value + delta));
        e.preventDefault();
      }
    },
    [value, min, max, step, onChange]
  );

  return (
    <div
      ref={ref}
      className={`tick-slider tick-slider--${variant}`}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div
        className="tick-slider-track"
        style={trackBackground ? { background: trackBackground } : undefined}
      />
      <div className="tick-slider-handle" style={{ left: `${pct}%` }} />
    </div>
  );
}
