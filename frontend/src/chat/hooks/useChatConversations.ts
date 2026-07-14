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
  // DM unread counts and last-activity, refreshed on mount, on a poll, and on demand
  // via `refreshSummary` when a DM arrives or a conversation is opened.
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
    // Fallback poll; WS-driven refreshes keep it snappier between ticks.
    const id = setInterval(() => void refreshSummary(), 60_000);
    return () => clearInterval(id);
  }, [currentUserId, refreshSummary]);

  // Broadcast the fresh total on every summary change, so the Layout sidebar badge
  // updates instantly without a refetch of its own.
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
