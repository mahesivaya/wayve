import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatSocket } from "../../chat/hooks/useChatSocket";
import { useCallSession } from "../../call/useCallSession";

// A minimal WebSocket stand-in the tests drive by hand.
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({});
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat socket across tabs", () => {
  it("refreshes unread counts when the user reads in another tab", () => {
    const onInbound = vi.fn();
    renderHook(() =>
      useChatSocket(
        { id: 1 },
        { current: null },
        vi.fn(),
        undefined,
        undefined,
        onInbound
      )
    );
    act(() => latest().open());
    act(() => latest().receive({ type: "conversation_read", user_id: 2 }));
    expect(onInbound).toHaveBeenCalledTimes(1);
  });
});

describe("call socket", () => {
  it("reconnects after a drop and keeps handling signals", () => {
    const { result } = renderHook(() => useCallSession(1, "me@x.test"));
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => latest().open());
    expect(result.current.connected).toBe(true);

    act(() => latest().drop());
    expect(result.current.connected).toBe(false);

    // Backoff is at most ~1.2s for the first retry.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => latest().open());
    expect(result.current.connected).toBe(true);

    // The reconnected socket still drives the call state machine.
    act(() =>
      latest().receive({
        type: "call-invite",
        to: 1,
        from: 2,
        media: "audio",
        from_email: "peer@x.test",
      })
    );
    expect(result.current.callState.kind).toBe("incoming");
  });

  it("does not reconnect after unmount", () => {
    const { unmount } = renderHook(() => useCallSession(1, "me@x.test"));
    act(() => latest().open());
    unmount();
    act(() => {
      latest().drop();
      vi.advanceTimersByTime(20000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
