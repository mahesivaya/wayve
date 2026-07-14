import { createContext, useContext } from "react";
import type { AppKey } from "./LayoutConfig";

// Lets a deeply-nested component (e.g. a task link in a chat message) open a
// split app in the right pane without threading callbacks through every layer.
// Layout supplies the real implementation; the default is inert so consumers
// outside Layout, including tests, fall back to normal navigation.
export type SplitTarget = { app: AppKey; taskId?: number };

export type SplitControlValue = {
  // Null when no Layout provider is present.
  openApp: ((app: AppKey, opts?: { taskId?: number }) => void) | null;
  // The focus target the pane app should honor on mount.
  target: SplitTarget | null;
  closeApp: (() => void) | null;
};

export const SplitControlContext = createContext<SplitControlValue>({
  openApp: null,
  target: null,
  closeApp: null,
});

export const useSplitControl = () => useContext(SplitControlContext);
