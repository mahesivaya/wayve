import { createContext, useContext } from "react";
import type { AppKey } from "./LayoutConfig";

// Lets a deeply-nested component (e.g. a task link inside a chat message) open
// one of the split apps in the right pane and hand it a focus target, without
// threading callbacks down through every layer. Layout provides the real
// implementation; the default is inert so consumers rendered outside Layout
// (or in tests) fall back to normal navigation.
export type SplitTarget = { app: AppKey; taskId?: number };

export type SplitControlValue = {
  // Open `app` in the right split pane. `opts.taskId` focuses a specific task
  // once the Tasks pane mounts. Null when no Layout provider is present.
  openApp: ((app: AppKey, opts?: { taskId?: number }) => void) | null;
  // The focus target the pane app should honor on mount, or null.
  target: SplitTarget | null;
  // Called by a pane app to dismiss itself (closes the pane). Null outside Layout.
  closeApp: (() => void) | null;
};

export const SplitControlContext = createContext<SplitControlValue>({
  openApp: null,
  target: null,
  closeApp: null,
});

export const useSplitControl = () => useContext(SplitControlContext);
