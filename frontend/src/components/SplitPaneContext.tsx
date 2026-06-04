import { createContext, useContext } from "react";

/**
 * True when the consuming page is rendered inside a Layout *split pane*
 * (the narrow side-by-side panes), false on a normal full-width page.
 *
 * Layout wraps each split pane's body in `<SplitPaneContext.Provider value>`;
 * pages read this to switch to a compact single-column layout when they're
 * squeezed into a pane (a viewport media query can't see the pane width).
 */
export const SplitPaneContext = createContext(false);

/** Convenience hook: `const inSplitPane = useInSplitPane();` */
export const useInSplitPane = () => useContext(SplitPaneContext);
