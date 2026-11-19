// With a Chat view open the popup cards stand down, so the view itself alerts
// for a message that arrives while nobody is looking at the app.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getChatUsers: vi.fn(async () => [{ id: 7, email: "ada@test.local" }]),
  getChatChannels: vi.fn(async () => [{ id: 3, name: "general" }]),
}));
vi.mock("../../api/chat", () => api);

const appInFocus = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../components/desktopNotifications", () => ({ appInFocus }));

const raiseArrivalAlert = vi.hoisted(() => vi.fn());
vi.mock("../../components/messageAlerts", () => ({ raiseArrivalAlert }));

vi.mock("../../chat/messagePreview", () => ({
  messagePreview: vi.fn(async (content: string) => content || null),
}));

const status = vi.hoisted(() => ({ value: "active" }));
vi.mock("../../chat/myStatus", () => ({ getMyStatus: () => status.value }));

import {
  alertUnseenChatMessage,
  resetChatAlertsForTests,
} from "../../chat/chatAlerts";

const ME = 1;
const dm = {
  sender_id: 7,
  receiver_id: ME,
  content: "Lunch?",
  status: "sent" as const,
  created_at: "2026-11-18T12:00:00Z",
};

describe("alertUnseenChatMessage", () => {
  beforeEach(() => {
    resetChatAlertsForTests();
    raiseArrivalAlert.mockReset();
    appInFocus.mockReturnValue(false);
    status.value = "active";
  });

  it("alerts for a direct message with its sender and text", async () => {
    const open = vi.fn();
    await alertUnseenChatMessage(dm, ME, open);
    expect(raiseArrivalAlert).toHaveBeenCalledTimes(1);
    const [kind, alert] = raiseArrivalAlert.mock.calls[0];
    expect(kind).toBe("chats");
    expect(alert).toMatchObject({
      title: "ada@test.local",
      body: "Lunch?",
      tag: "chat:dm:7",
    });
    alert.onClick();
    expect(open).toHaveBeenCalledWith("/chat?dm=7");
  });

  it("names the channel and the author for a channel message", async () => {
    await alertUnseenChatMessage(
      { ...dm, receiver_id: undefined, channel_id: 3, sender_name: "Ada" },
      ME,
      vi.fn()
    );
    expect(raiseArrivalAlert.mock.calls[0][1]).toMatchObject({
      title: "#general",
      body: "Ada: Lunch?",
      tag: "chat:c:3",
    });
  });

  it("says only that a message came when it can't be read here", async () => {
    await alertUnseenChatMessage({ ...dm, content: "" }, ME, vi.fn());
    expect(raiseArrivalAlert.mock.calls[0][1].body).toBe("New message");
  });

  it("stays quiet in view, under Do Not Disturb, and for non-messages", async () => {
    appInFocus.mockReturnValue(true);
    await alertUnseenChatMessage(dm, ME, vi.fn());

    appInFocus.mockReturnValue(false);
    status.value = "dnd";
    await alertUnseenChatMessage(dm, ME, vi.fn());

    status.value = "active";
    await alertUnseenChatMessage({ ...dm, sender_id: ME }, ME, vi.fn());
    await alertUnseenChatMessage(
      { ...dm, type: "conversation_read" },
      ME,
      vi.fn()
    );
    expect(raiseArrivalAlert).not.toHaveBeenCalled();
  });
});
