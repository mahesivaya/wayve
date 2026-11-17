// The mail page refreshes the moment the server announces a sync (the Gmail
// push nudge on the per-user socket), instead of waiting for its 60s poll.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMAILS_SYNCED_EVENT,
  useEmailLiveRefresh,
} from "../../emails/useEmailLiveRefresh";

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const open = () => FakeSocket.all.filter((s) => !s.closed);

describe("useEmailLiveRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    setHidden(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setHidden(false);
  });

  it("refreshes once for a burst of mail broadcasts, and tells the badges", () => {
    const onChange = vi.fn();
    const onSynced = vi.fn();
    window.addEventListener(EMAILS_SYNCED_EVENT, onSynced);
    renderHook(() => useEmailLiveRefresh(1, onChange));

    expect(open()).toHaveLength(1);
    expect(open()[0].url).toMatch(/\/ws\/chat$/);
    act(() => {
      open()[0].receive({ type: "email:new", account_id: 7 });
      open()[0].receive({ type: "email:new", account_id: 7 });
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onSynced).toHaveBeenCalledTimes(1);
    window.removeEventListener(EMAILS_SYNCED_EVENT, onSynced);
  });

  it("ignores chat frames on the shared socket", () => {
    const onChange = vi.fn();
    renderHook(() => useEmailLiveRefresh(1, onChange));

    act(() => {
      open()[0].receive({ type: "presence", user_id: 2, online: true });
      open()[0].receive({ sender_id: 2, receiver_id: 1, content: "hi" });
      open()[0].onmessage?.({ data: "not json" });
      vi.advanceTimersByTime(500);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays disconnected without a user", () => {
    renderHook(() => useEmailLiveRefresh(undefined, vi.fn()));
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("closes while the tab is hidden and reconnects when it returns", () => {
    renderHook(() => useEmailLiveRefresh(1, vi.fn()));
    expect(open()).toHaveLength(1);

    act(() => setHidden(true));
    expect(open()).toHaveLength(0);
    // A socket it closed itself must not schedule a reconnect.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(FakeSocket.all).toHaveLength(1);

    act(() => setHidden(false));
    expect(open()).toHaveLength(1);
  });

  it("reconnects after a drop and refreshes for what it may have missed", () => {
    const onChange = vi.fn();
    renderHook(() => useEmailLiveRefresh(1, onChange));
    const first = open()[0];

    act(() => {
      first.close();
      vi.advanceTimersByTime(2_000);
    });
    expect(open()).toHaveLength(1);
    expect(open()[0]).not.toBe(first);

    act(() => {
      open()[0].onopen?.();
      vi.advanceTimersByTime(500);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes the socket on unmount", () => {
    const { unmount } = renderHook(() => useEmailLiveRefresh(1, vi.fn()));
    unmount();
    expect(open()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(FakeSocket.all).toHaveLength(1);
  });
});
