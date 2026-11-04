import { isBwInput } from "./blackAndWhite";
import type { ThemeChoice, UiOverrides } from "./customThemeShared";

export type BasicThemeMode = "system" | "light" | "dark";

// Which of the plain System / Light / Dark choices is active, or null for any
// other theme. Light is the app's white default; Dark is the editor's plain black
// (its black & white toggle), not a tinted dark preset. Per-role colour overrides
// make any of them a custom look, so only an untouched one counts.
export function basicThemeMode(
  choice: ThemeChoice,
  ui: UiOverrides
): BasicThemeMode | null {
  if (Object.keys(ui).length > 0) return null;
  if (choice.kind === "system") return "system";
  if (choice.kind === "default") return "light";
  if (
    choice.kind === "custom" &&
    choice.mode === "dark" &&
    isBwInput(choice.input)
  ) {
    return "dark";
  }
  return null;
}
