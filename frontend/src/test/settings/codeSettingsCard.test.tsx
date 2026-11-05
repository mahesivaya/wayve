// Code on the General settings page: each choice reaches the code through CSS
// variables at once, is remembered, and every theme stays readable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CodeFile } from "../../github/CodeFile";
import {
  CODE_THEMES,
  DEFAULT_CODE_SETTINGS,
  saveCodeSettings,
} from "../../github/codeSettings";
import CodeSettingsCard from "../../profile/CodeSettingsCard";

const rootVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

const reset = () => act(() => saveCodeSettings(DEFAULT_CODE_SETTINGS));

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe("the code settings card", () => {
  it("changes the size, font and line height straight away", async () => {
    render(<CodeSettingsCard />);

    await userEvent.selectOptions(screen.getByLabelText("Font size"), "16");
    expect(rootVar("--syntax-font-size")).toBe("16px");

    await userEvent.selectOptions(screen.getByLabelText("Font"), "menlo");
    expect(rootVar("--syntax-font-family")).toContain("Menlo");

    await userEvent.selectOptions(
      screen.getByLabelText("Line height"),
      "relaxed"
    );
    expect(rootVar("--syntax-line-height")).toBe("1.75");
  });

  it("changes the style: weight and italic comments", async () => {
    render(<CodeSettingsCard />);

    await userEvent.selectOptions(
      screen.getByLabelText("Font weight"),
      "medium"
    );
    expect(rootVar("--syntax-font-weight")).toBe("500");

    expect(rootVar("--syntax-comment-style")).toBe("italic");
    await userEvent.click(
      screen.getByRole("switch", { name: "Italic comments" })
    );
    expect(rootVar("--syntax-comment-style")).toBe("normal");
  });

  it("applies a theme's colours, and clears them to match the interface", async () => {
    render(<CodeSettingsCard />);
    const select = screen.getByLabelText("Code theme");

    await userEvent.selectOptions(select, "dracula");
    expect(rootVar("--syntax-bg")).toBe(CODE_THEMES.dracula.bg);
    expect(rootVar("--syntax-keyword")).toBe(
      CODE_THEMES.dracula.tokens.keyword
    );

    await userEvent.selectOptions(select, "auto");
    expect(rootVar("--syntax-bg")).toBe("");
    expect(rootVar("--syntax-keyword")).toBe("");
  });

  it("can't let a custom font family write other CSS", async () => {
    render(<CodeSettingsCard />);
    await userEvent.type(
      screen.getByLabelText("Custom font family"),
      'Iosevka"; color: red'
    );
    expect(rootVar("--syntax-font-family")).toBe(
      '"Iosevka color red", var(--mono)'
    );
  });

  it("remembers the choices and resets them", async () => {
    render(<CodeSettingsCard />);
    expect(
      screen.queryByRole("button", { name: "Reset to defaults" })
    ).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Font size"), "14");
    expect(
      JSON.parse(localStorage.getItem("rwayve.code.settings.v1") ?? "{}")
        .fontSize
    ).toBe(14);

    await userEvent.click(
      screen.getByRole("button", { name: "Reset to defaults" })
    );
    expect(rootVar("--syntax-font-size")).toBe("13px");
  });

  it("previews each language in diff and file form", async () => {
    const { container } = render(<CodeSettingsCard />);
    expect(container.querySelector(".github-unified .is-add")).toBeTruthy();

    await userEvent.selectOptions(
      screen.getByLabelText("Preview language"),
      "Python"
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Preview view"),
      "file"
    );
    expect(container.querySelector(".github-code-file")?.textContent).toContain(
      "RETRIES: int = 3"
    );
  });
});

describe("stored settings", () => {
  it("ignores values that are no longer options", async () => {
    localStorage.setItem(
      "rwayve.code.settings.v1",
      JSON.stringify({ theme: "gone", fontSize: 999, font: "menlo" })
    );
    vi.resetModules();
    const fresh = await import("../../github/codeSettings");
    expect(rootVar("--syntax-font-size")).toBe("13px");
    expect(rootVar("--syntax-font-family")).toContain("Menlo");
    expect(rootVar("--syntax-bg")).toBe("");
    fresh.saveCodeSettings(fresh.DEFAULT_CODE_SETTINGS);
    localStorage.removeItem("rwayve.code.settings.v1");
  });
});

describe("the file view options", () => {
  it("follows wrap and line number choices", () => {
    act(() =>
      saveCodeSettings({
        ...DEFAULT_CODE_SETTINGS,
        wrapLines: true,
        lineNumbers: false,
      })
    );
    const { container } = render(<CodeFile path="a.rs" text="fn a() {}" />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("is-wrapped");
    expect(pre?.className).toContain("no-line-numbers");
  });
});

describe("code themes", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it.each(Object.entries(CODE_THEMES))("%s is readable", (_id, theme) => {
    expect(contrast(theme.fg, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.gutter, theme.bg)).toBeGreaterThanOrEqual(3);
    for (const [token, color] of Object.entries(theme.tokens)) {
      expect(
        contrast(color, theme.bg),
        `${token} ${color} on ${theme.bg}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
