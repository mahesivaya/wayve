// The alert for a chat message that arrives while a Chat view is open but
// nobody is looking at the app. Away from chat, the app-wide popup cards raise
// it instead (components/ChatPopups.tsx), so only one of the two ever runs.
import {
  getChatChannels,
  getChatUsers,
  type ChatChannel,
  type ChatMessage,
  type ChatUser,
} from "../api/chat";
import { appInFocus } from "../components/desktopNotifications";
import { raiseArrivalAlert } from "../components/messageAlerts";
import { messagePreview } from "./messagePreview";
import { getMyStatus } from "./myStatus";

let users: Promise<ChatUser[]> | null = null;
let channels: Promise<ChatChannel[]> | null = null;

// Cached for the session; a failed load is dropped so the next message retries.
const loadUsers = () =>
  (users ??= getChatUsers().catch(() => {
    users = null;
    return [];
  }));
const loadChannels = () =>
  (channels ??= getChatChannels().catch(() => {
    channels = null;
    return [];
  }));

export function resetChatAlertsForTests() {
  users = null;
  channels = null;
}

export async function alertUnseenChatMessage(
  msg: ChatMessage & { type?: string },
  myId: number,
  open: (href: string) => void
): Promise<void> {
  // Only real messages from someone else: other frames carry a type.
  if (msg.type || msg.sender_id === myId) return;
  // Someone looking at the app sees the message itself; Do Not Disturb is quiet.
  if (appInFocus() || getMyStatus() === "dnd") return;

  const preview = await messagePreview(msg.content, myId);
  const sender =
    msg.sender_name ??
    (await loadUsers()).find((u) => u.id === msg.sender_id)?.email ??
    null;

  if (msg.channel_id != null) {
    const channelId = msg.channel_id;
    const channel = (await loadChannels()).find((c) => c.id === channelId);
    raiseArrivalAlert("chats", {
      title: channel ? `#${channel.name}` : "New channel message",
      body: [sender, preview ?? "New message"].filter(Boolean).join(": "),
      tag: `chat:c:${channelId}`,
      onClick: () => open(`/chat?c=${channelId}`),
    });
    return;
  }
  raiseArrivalAlert("chats", {
    title: sender ?? "New message",
    body: preview ?? "New message",
    tag: `chat:dm:${msg.sender_id}`,
    onClick: () => open(`/chat?dm=${msg.sender_id}`),
  });
}
