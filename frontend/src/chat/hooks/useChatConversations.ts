import { useEffect, useState } from "react";
import {
  getChatChannels,
  getChatUsers,
  type ChatChannel,
  type ChatUser,
} from "../../api/chat";
import { logger } from "../../utils/logger";

export function useChatConversations(currentUserId?: number) {
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [channels, setChannels] = useState<ChatChannel[]>([]);

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const [usersData, channelData] = await Promise.all([
          getChatUsers(),
          getChatChannels(),
        ]);
        setUsers(usersData.filter((u) => u.id !== currentUserId));
        setChannels(channelData);
      } catch (err) {
        logger.error("Fetch chat conversations failed", err);
      }
    };

    if (currentUserId) void fetchConversations();
  }, [currentUserId]);

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
  };
}
