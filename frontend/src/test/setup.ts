import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom 29 + vitest 4 doesn't always expose a working Storage. Install a
// minimal in-memory polyfill on both `globalThis` and `window` so component
// code that touches `localStorage` directly Just Works in tests.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

const installStorage = (
  target: object,
  prop: "localStorage" | "sessionStorage"
) => {
  Object.defineProperty(target, prop, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: new MemoryStorage(),
  });
};

installStorage(globalThis, "localStorage");
installStorage(globalThis, "sessionStorage");
if (typeof window !== "undefined") {
  installStorage(window, "localStorage");
  installStorage(window, "sessionStorage");
}

// jsdom implements no CSS layout, so it ships no `matchMedia` at all. Anything
// rendering a responsive component (useIsNarrow, and so Layout / SettingsShell)
// would throw on mount. Report "not matching" — the wide/desktop branch — which
// is the layout these tests assert against.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        // Deprecated pair, still called by some libraries.
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

// jsdom has no layout, so it implements no scrolling APIs either. Components
// that keep a highlighted row in view (the scheduler's time picker, chat lists)
// would throw on mount without this no-op.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  (globalThis as unknown as { localStorage: Storage }).localStorage.clear();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
  vi.restoreAllMocks();
});

// VITE_API_URL is read at module-load time; default it to a stable value
// so tests don't depend on a real .env file.
if (!import.meta.env.VITE_API_URL) {
  // @ts-expect-error mutating import.meta.env in tests
  import.meta.env.VITE_API_URL = "http://test.local";
}
