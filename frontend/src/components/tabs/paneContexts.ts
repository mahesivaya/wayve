import { createContext, type ReactNode } from "react";

/**
 * App.tsx provides its route table as a render function so a split pane can
 * render ANY URL (a single ticket, a settings page, …) the same way the main
 * view does — the Cursor/VS Code model, where a dragged tab opens its exact
 * page beside the current one. Null in tests that mount Layout on its own.
 */
export const PaneRoutesContext = createContext<
  ((location: string) => ReactNode) | null
>(null);

/** True inside a PathPane, so Layout renders only its outlet there (no nested
 *  header/sidebar/tab strip). */
export const InPaneContext = createContext(false);
