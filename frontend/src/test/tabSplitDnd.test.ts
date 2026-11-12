import { describe, expect, it } from "vitest";
import {
  appKeyForTabPath,
  PANE_DND_MIME,
  readPaneDragData,
  tabDropZoneFromPointer,
} from "../components/paneDnd";

const rect = { left: 100, width: 400 };

describe("header tab → split drag", () => {
  it("splits only once the pointer is past the middle of the pane", () => {
    expect(tabDropZoneFromPointer(rect, 150)).toBeNull();
    expect(tabDropZoneFromPointer(rect, 300)).toBeNull(); // exactly half
    expect(tabDropZoneFromPointer(rect, 301)).toBe("right");
    expect(tabDropZoneFromPointer(rect, 499)).toBe("right");
    expect(tabDropZoneFromPointer({ left: 0, width: 0 }, 10)).toBeNull();
  });

  it("maps a tab URL to its split-pane app", () => {
    expect(appKeyForTabPath("/")).toBe("home");
    expect(appKeyForTabPath("/tickets")).toBe("tickets");
    expect(appKeyForTabPath("/tickets/5")).toBe("tickets");
    expect(appKeyForTabPath("/chat")).toBe("chat");
    expect(appKeyForTabPath("/settings")).toBeNull();
  });

  it("round-trips a tab payload (exact URL + title)", () => {
    const store = new Map<string, string>();
    const dt = {
      getData: (k: string) => store.get(k) ?? "",
    } as unknown as DataTransfer;
    store.set(
      PANE_DND_MIME,
      JSON.stringify({
        kind: "tab",
        tabId: "t1",
        path: "/tickets/6",
        title: "#6 Perf",
        source: "main",
      })
    );
    expect(readPaneDragData(dt)).toEqual({
      kind: "tab",
      tabId: "t1",
      path: "/tickets/6",
      title: "#6 Perf",
      source: "main",
    });
    // Only same-origin absolute paths are accepted.
    store.set(
      PANE_DND_MIME,
      JSON.stringify({ kind: "tab", tabId: "t1", path: "https://evil.example" })
    );
    expect(readPaneDragData(dt)).toBeNull();
  });
});
