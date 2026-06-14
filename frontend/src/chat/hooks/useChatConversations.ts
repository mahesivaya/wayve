import { useCallback, useEffect, useState } from "react";
import {
  getChatChannels,
  getChatConversationSummary,
  getChatUsers,
  type ChatChannel,
  type ChatConversationSummary,
  type ChatUser,
} from "../../api/chat";
import { logger } from "../../utils/logger";
import { CHAT_UNREAD_CHANGED_EVENT } from "../useChatUnreadCount";

export function useChatConversations(currentUserId?: number) {
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  // DM unread counts + last-activity, for the Unread/Recent sections and the
  // total badge. Refreshed on mount, on a light poll, and on demand (WS
  // inbound DM / opening a conversation) via `refreshSummary`.
  const [summary, setSummary] = useState<ChatConversationSummary>({
    total_unread: 0,
    conversations: [],
  });

  const refreshSummary = useCallback(async () => {
    try {
      const data = await getChatConversationSummary();
      setSummary(data);
    } catch (err) {
      logger.error("Fetch chat conversation summary failed", err);
    }
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    const fetchConversations = async () => {
      try {
        const [usersData, channelData, summaryData] = await Promise.all([
          getChatUsers(),
          getChatChannels(),
          getChatConversationSummary(),
        ]);
        setUsers(usersData.filter((u) => u.id !== currentUserId));
        setChannels(channelData);
        setSummary(summaryData);
      } catch (err) {
        logger.error("Fetch chat conversations failed", err);
      }
    };

    void fetchConversations();
    // Light poll as a fallback; WS-driven refreshes keep it snappier.
    const id = setInterval(() => void refreshSummary(), 60_000);
    return () => clearInterval(id);
  }, [currentUserId, refreshSummary]);

  // Keep the sidebar Chat badge in lock-step: every time our summary changes
  // (WS inbound DM, opening/reading a conversation, poll) broadcast the fresh
  // total so the Layout badge updates instantly without its own refetch.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(CHAT_UNREAD_CHANGED_EVENT, {
        detail: summary.total_unread,
      })
    );
  }, [summary.total_unread]);

  const refreshChannels = async () => {
    const channelData = await getChatChannels();
    setChannels(channelData);
    return channelData;
  };

  return {
    users,
    channels,
    setChannels,
    refreshChannels,
    summary,
    refreshSummary,
  };
}
