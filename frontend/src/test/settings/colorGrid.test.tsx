// Clicking a dot picks the theme: its column sets the color, and its row sets
// light or dark and how strong the color is. Browser layout is stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import ColorGrid from "../../theme/ColorGrid";
import type { ThemeMode } from "../../theme/customThemeShared";

const WIDTH = 600;
const HEIGHT = 220;
const onChange = vi.fn();

function Harness() {
  const [theme, setTheme] = useState({
    hue: 180,
    chroma: 0.04,
    mode: "light" as ThemeMode,
  });
  return (
    <ColorGrid
      {...theme}
      onChange={(next) => {
        onChange(next);
        setTheme(next);
      }}
    />
  );
}

const grid = () => screen.getByRole("slider");
const marker = () =>
  document.querySelector<HTMLElement>(".color-grid-marker") as HTMLElement;

// Each dot is 10 x 10 at this size.
const clickDot = (col: number, row: number) =>
  fireEvent.pointerDown(grid(), {
    pointerId: 1,
    clientX: col * 10 + 5,
    clientY: row * 10 + 5,
  });

beforeEach(() => {
  onChange.mockClear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: WIDTH,
    height: HEIGHT,
  } as DOMRect);
});

describe("clicking a dot", () => {
  it.each([
    { name: "palest bright", row: 0, mode: "light", chroma: 0.04 },
    { name: "strongest bright", row: 10, mode: "light", chroma: 0.3 },
    { name: "strongest dark", row: 11, mode: "dark", chroma: 0.3 },
    { name: "faintest dark", row: 21, mode: "dark", chroma: 0.04 },
  ])("the $name row gives a $mode theme", ({ row, mode, chroma }) => {
    render(<Harness />);

    clickDot(30, row);

    const picked = onChange.mock.calls[0][0];
    expect(picked.mode).toBe(mode);
    expect(picked.chroma).toBeCloseTo(chroma);
  });

  it("takes the color of the dot's column", () => {
    render(<Harness />);

    clickDot(10, 3);

    expect(onChange.mock.calls[0][0].hue).toBe(60);
  });

  it.each([
    [10, 3],
    [45, 8],
    [0, 12],
    [59, 21],
  ])("puts the marker on the clicked dot (%i, %i)", (col, row) => {
    render(<Harness />);

    clickDot(col, row);

    expect(parseFloat(marker().style.left)).toBeCloseTo(
      ((col + 0.5) / 60) * 100
    );
    expect(parseFloat(marker().style.top)).toBeCloseTo(
      ((row + 0.5) / 22) * 100
    );
  });
});

describe("the arrow keys", () => {
  it("cross from the bright band into the dark one", () => {
    render(<Harness />);
    clickDot(30, 10);
    onChange.mockClear();

    fireEvent.keyDown(grid(), { key: "ArrowDown" });

    expect(onChange.mock.calls[0][0].mode).toBe("dark");
  });

  it("move one dot sideways", () => {
    render(<Harness />);
    clickDot(30, 5);
    onChange.mockClear();

    fireEvent.keyDown(grid(), { key: "ArrowRight" });

    expect(onChange.mock.calls[0][0].hue).toBe(186);
  });
});
