import { Suspense, useContext, useMemo, type ReactNode } from "react";
import { InPaneContext, PaneRoutesContext } from "./paneContexts";
import {
  createPath,
  UNSAFE_NavigationContext as NavigationContext,
  UNSAFE_RouteContext as RouteContext,
  type To,
} from "react-router-dom";

const EMPTY_ROUTE_CONTEXT = { outlet: null, matches: [], isDataRoute: false };

function toPath(to: To): string {
  return typeof to === "string" ? to : createPath(to);
}

/**
 * Renders `path` through the app routes with its own navigation: links and
 * navigate() calls inside the pane move only this pane (via `onNavigate`),
 * never the main view.
 */
export default function PathPane({
  path,
  onNavigate,
  fallback = null,
}: {
  path: string;
  onNavigate: (path: string) => void;
  /** Rendered when no route table is provided (Layout mounted on its own). */
  fallback?: ReactNode;
}) {
  const renderRoutes = useContext(PaneRoutesContext);
  const nav = useContext(NavigationContext);

  const navValue = useMemo(
    () => ({
      ...nav,
      navigator: {
        ...nav.navigator,
        push: (to: To) => onNavigate(toPath(to)),
        replace: (to: To) => onNavigate(toPath(to)),
        // History steps would move the main view; a pane has no history.
        go: () => {},
      },
    }),
    [nav, onNavigate]
  );

  if (!renderRoutes) return <>{fallback}</>;

  return (
    <InPaneContext.Provider value={true}>
      <NavigationContext.Provider value={navValue}>
        {/* Reset the parent route context so the pane's <Routes> matches
            absolute URLs instead of nesting under the Layout route. */}
        <RouteContext.Provider value={EMPTY_ROUTE_CONTEXT}>
          <Suspense
            fallback={<div className="path-pane-loading">Loading…</div>}
          >
            {renderRoutes(path)}
          </Suspense>
        </RouteContext.Provider>
      </NavigationContext.Provider>
    </InPaneContext.Provider>
  );
}
