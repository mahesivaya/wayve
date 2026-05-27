import { useContext } from "react";

import { CustomThemeContext } from "./customThemeShared";

export function useCustomTheme() {
  const ctx = useContext(CustomThemeContext);
  if (!ctx) {
    throw new Error(
      "useCustomTheme must be used inside a <CustomThemeProvider>",
    );
  }
  return ctx;
}
