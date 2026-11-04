// The app's one call session: it reaches you on any page, rings while a call is
// incoming, and notifies only when the app isn't in front of you.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({
  user: { id: 1, email: "me@x.test" } as { id: number; email: string } | null,
}));
vi.mock("../../auth/useAuth", () => ({ useAuth: () => auth }));

const sound = vi.hoisted(() => ({
  startRingtone: vi.fn(),
  stopRingtone: vi.fn(),
  playChime: vi.fn(),
  primeNotificationSound: vi.fn(() => () => {}),
}));
vi.mock("../../components/notificationSound", () => sound);

import { CallProvider } from "../../call/CallContext";
import { useSharedCall } from "../../call/useSharedCall";
import {
  closeDesktopNotification,
  showDesktopNotification,
} from "../../components/desktopNotifications";
import { setAlertEnabled } from "../../components/notificationPrefs";

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
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
}

class FakeNotification {
  static permission = "granted";
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options: { body: string; tag: string }
  ) {
    FakeNotification.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];

const receive = (signal: Record<string, unknown>) =>
  act(async () => {
    socket().onmessage?.({ data: JSON.stringify(signal) });
    await Promise.resolve();
  });

const invite = () =>
  receive({
    type: "call-invite",
    to: 1,
    from: 2,
    media: "video",
    from_email: "peer@x.test",
  });

function Reader({ label }: { label: string }) {
  const { callState } = useSharedCall();
  return (
    <span data-testid={label}>
      {callState.kind === "idle" ? "idle" : callState.kind}
    </span>
  );
}

const focusApp = (focused: boolean) =>
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);

describe("the shared call session", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    FakeNotification.instances = [];
    localStorage.clear();
    auth.user = { id: 1, email: "me@x.test" };
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("Notification", FakeNotification);
    sound.startRingtone.mockClear();
    sound.stopRingtone.mockClear();
    focusApp(false);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens one socket however many pages read it", () => {
    render(
      <CallProvider>
        <Reader label="chat" />
        <Reader label="call-page" />
      </CallProvider>
    );
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("opens no socket when signed out", () => {
    auth.user = null;
    render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("shows an incoming call over any page, with the session shared", async () => {
    render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await invite();
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "peer@x.test"
    );
    expect(screen.getByTestId("page").textContent).toBe("incoming");
  });

  it("rings and notifies while incoming, and stops when the caller cancels", async () => {
    render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await invite();
    expect(sound.startRingtone).toHaveBeenCalledTimes(1);
    const [toast] = FakeNotification.instances;
    expect(toast.title).toBe("Incoming video call");
    expect(toast.options.body).toBe("peer@x.test");

    await receive({ type: "call-cancel", to: 1, from: 2 });
    expect(sound.stopRingtone).toHaveBeenCalled();
    expect(toast.closed).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("rings but doesn't notify when you're already looking at the app", async () => {
    focusApp(true);
    render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await invite();
    expect(sound.startRingtone).toHaveBeenCalledTimes(1);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("respects each switch on its own", async () => {
    setAlertEnabled("calls", "sound", false);
    render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await invite();
    expect(sound.startRingtone).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(1);
    await receive({ type: "call-cancel", to: 1, from: 2 });

    setAlertEnabled("calls", "sound", true);
    setAlertEnabled("calls", "notification", false);
    await invite();
    expect(sound.startRingtone).toHaveBeenCalledTimes(1);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("clears the call off screen on logout", async () => {
    const { rerender } = render(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await invite();
    const first = socket();

    auth.user = null;
    rerender(
      <CallProvider>
        <Reader label="page" />
      </CallProvider>
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("page").textContent).toBe("idle");
    expect(sound.stopRingtone).toHaveBeenCalled();
  });

  it("gives pages a harmless idle session without a provider", () => {
    render(<Reader label="page" />);
    expect(screen.getByTestId("page").textContent).toBe("idle");
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe("taking back a desktop notification", () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    localStorage.clear();
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes only the one with that tag", () => {
    showDesktopNotification("a", "", "tag-a");
    showDesktopNotification("b", "", "tag-b");
    closeDesktopNotification("tag-a");
    closeDesktopNotification("never-raised");
    expect(FakeNotification.instances.map((n) => n.closed)).toEqual([
      true,
      false,
    ]);
  });
});
