import { useSyncExternalStore } from "react";

// Whether the page is currently painted dark.
//
// `useTheme` holds the choice in its own component state, so two callers each
// get their own copy and a toggle in the header never reaches the rest of the
// tree. The one thing every caller *does* share is the `data-theme` attribute
// the toggle writes to <html> — so that attribute is the store, and this is a
// subscription to it. Anything that has to adapt its own colours to the surface
// (a chart picking fills that stay legible) needs this rather than the choice
// as it stood at mount.

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

// A primitive, so React can compare snapshots without a cache.
function getSnapshot(): boolean {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

// Light is the app's default, and what the pre-paint script assumes.
function getServerSnapshot(): boolean {
  return false;
}

export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
