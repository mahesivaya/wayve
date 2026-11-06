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

function Caller() {
  const { startCall } = useSharedCall();
  return <button onClick={() => startCall(2, "peer@x.test", "audio")}>call</button>;
}

describe("starting a call", () => {
  const getUserMedia = vi.fn();
  const sentTypes = () =>
    socket().sent.map((s) => (JSON.parse(s) as { type: string }).type);

  beforeEach(() => {
    FakeSocket.instances = [];
    auth.user = { id: 1, email: "me@x.test" };
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("Notification", FakeNotification);
    getUserMedia.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  // Holds the permission prompt open until the test resolves it.
  const pendingPrompt = () => {
    const stop = vi.fn();
    let grant: () => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = () => resolve({ getTracks: () => [{ stop }] });
      })
    );
    return { stop, grant: () => act(async () => grant()) };
  };

  it("asks for the microphone before ringing the peer", async () => {
    getUserMedia.mockResolvedValue({ getTracks: () => [] });
    render(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    await act(async () => {
      screen.getByText("call").click();
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(sentTypes()).toEqual(["call-invite"]);
    expect(screen.getByRole("status").textContent).toContain("peer@x.test");
  });

  it("doesn't ring anyone when the microphone is blocked, and says why", async () => {
    getUserMedia.mockRejectedValue(
      new DOMException("denied", "NotAllowedError")
    );
    render(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    await act(async () => {
      screen.getByText("call").click();
    });
    expect(sentTypes()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain(
      "microphone is blocked"
    );
    await act(async () => {
      screen.getByText("Dismiss").click();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns away an incoming call while the prompt is open", async () => {
    const prompt = pendingPrompt();
    render(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    await act(async () => {
      screen.getByText("call").click();
    });
    await invite();
    expect(sentTypes()).toEqual(["call-reject"]);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await prompt.grant();
    expect(sentTypes()).toEqual(["call-reject", "call-invite"]);
  });

  it("drops the call and releases the mic when you log out mid-prompt", async () => {
    const prompt = pendingPrompt();
    const { rerender } = render(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    await act(async () => {
      screen.getByText("call").click();
    });
    const first = socket();
    auth.user = null;
    rerender(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    await prompt.grant();
    expect(prompt.stop).toHaveBeenCalled();
    expect(first.sent).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("doesn't open the mic when the call socket is down", async () => {
    render(
      <CallProvider>
        <Caller />
      </CallProvider>
    );
    socket().readyState = FakeSocket.CLOSED;
    await act(async () => {
      screen.getByText("call").click();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Not connected");
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
