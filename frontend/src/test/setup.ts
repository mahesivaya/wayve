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
