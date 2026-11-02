// Sidebar badge counts (tickets, user stories) refresh on their own writes in
// any open tab, on focus, and on a short poll while visible — so a change shows
// in seconds instead of after the old 60s poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  LIVE_COUNT_POLL_MS,
  useLiveCount,
} from "../../components/useLiveCount";
import { announceChange } from "../../utils/crossTabEvents";

const EVENT = "rwayve:test-changed";

const setVisibility = (state: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });

describe("useLiveCount", () => {
  beforeEach(() => setVisibility("visible"));
  afterEach(() => vi.useRealTimers());

  it("fetches on mount and again when the change event fires", async () => {
    const fetchCount = vi.fn().mockResolvedValueOnce(2).mockResolvedValue(5);
    const { result } = renderHook(() => useLiveCount(fetchCount, EVENT));
    await waitFor(() => expect(result.current).toBe(2));

    act(() => announceChange(EVENT));
    await waitFor(() => expect(result.current).toBe(5));
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });

  it("refreshes when the window regains focus", async () => {
    const fetchCount = vi.fn().mockResolvedValue(1);
    renderHook(() => useLiveCount(fetchCount, EVENT));
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });

  it("polls while visible and skips the poll while hidden", async () => {
    vi.useFakeTimers();
    const fetchCount = vi.fn().mockResolvedValue(0);
    renderHook(() => useLiveCount(fetchCount, EVENT));
    expect(fetchCount).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(LIVE_COUNT_POLL_MS);
    });
    expect(fetchCount).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(LIVE_COUNT_POLL_MS * 3);
    });
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });

  it("does not fetch while disabled", () => {
    const fetchCount = vi.fn().mockResolvedValue(0);
    renderHook(() => useLiveCount(fetchCount, EVENT, false));
    act(() => announceChange(EVENT));
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("refreshes when another tab announces a change", async () => {
    const fetchCount = vi.fn().mockResolvedValue(3);
    renderHook(() => useLiveCount(fetchCount, EVENT));
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));

    // A second channel on the same name stands in for another tab.
    const otherTab = new BroadcastChannel("rwayve:changes");
    otherTab.postMessage(EVENT);
    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(2));
    otherTab.close();
  });
});
