import { useEffect, useRef, useState, type ReactNode } from "react";
import "./apps.css";

type Props = {
  left: ReactNode;
  right: ReactNode;
};

const MIN_PCT = 15;
const MAX_PCT = 85;
const STORAGE_KEY = "rwayve.splitView.leftPct";

export default function SplitView({ left, right }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const [leftPct, setLeftPct] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_PCT && parsed <= MAX_PCT
      ? parsed
      : 50;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(leftPct));
  }, [leftPct]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(MAX_PCT, Math.max(MIN_PCT, pct));
      setLeftPct(clamped);
    }
    function onUp() {
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function startDrag() {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div className="split-view" ref={containerRef}>
      <div className="split-view-pane" style={{ width: `${leftPct}%` }}>
        {left}
      </div>
      <div
        className="split-view-divider"
        onMouseDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        data-tooltip="Drag to resize"
      />
      <div className="split-view-pane" style={{ width: `${100 - leftPct}%` }}>
        {right}
      </div>
    </div>
  );
}
