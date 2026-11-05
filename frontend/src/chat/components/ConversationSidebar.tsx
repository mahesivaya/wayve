import { useEffect, useState } from "react";
import type {
  ChatChannel,
  ChatConversationSummary,
  ChatUser,
} from "../../api/chat";
import { useGlobalSearch } from "../../search/SearchContext";
import type { PresenceMap } from "../hooks/usePresence";
import type { ChannelVisibility, Conversation } from "../types";
import ChannelCreateForm from "./ChannelCreateForm";
import ChannelList from "./ChannelList";
import PersonalChatList from "./PersonalChatList";
import RecentConversations from "./RecentConversations";
import StartChatForm from "./StartChatForm";
import StatusSelector from "./StatusSelector";

type Props = {
  // The signed-in user, for the presence-status picker.
  myUserId: number;
  users: ChatUser[];
  channels: ChatChannel[];
  // Organization and platform accounts see every channel in their tenant. When
  // set, the list starts with just the ones the user belongs to, and "Browse
  // channels" reveals the rest to join.
  myChannelsByDefault: boolean;
  selectedConversation: Conversation | null;
  creatingChannel: boolean;
  channelName: string;
  channelVisibility: ChannelVisibility;
  canChooseVisibility: boolean;
  channelError: string;
  onToggleCreateChannel: () => void;
  onChannelNameChange: (value: string) => void;
  onChannelVisibilityChange: (value: ChannelVisibility) => void;
  onCancelCreateChannel: () => void;
  onCreateChannel: () => void;
  onSelectChannel: (channel: ChatChannel) => void;
  onJoinChannel: (channel: ChatChannel) => void;
  onSelectUser: (user: ChatUser) => void;
  // A user found by email via the "+" next to Users, possibly not yet in `users`.
  onStartChat: (user: ChatUser) => void;
  summary: ChatConversationSummary;
  presence: PresenceMap;
};

export default function ConversationSidebar({
  myUserId,
  users,
  channels,
  myChannelsByDefault,
  selectedConversation,
  creatingChannel,
  channelName,
  channelVisibility,
  canChooseVisibility,
  channelError,
  onToggleCreateChannel,
  onChannelNameChange,
  onChannelVisibilityChange,
  onCancelCreateChannel,
  onCreateChannel,
  onSelectChannel,
  onJoinChannel,
  onSelectUser,
  onStartChat,
  summary,
  presence,
}: Props) {
  const { setSearchQuery } = useGlobalSearch();
  const [startingChat, setStartingChat] = useState(false);
  const [browsingChannels, setBrowsingChannels] = useState(false);

  const selectedChannelId =
    selectedConversation?.type === "channel"
      ? selectedConversation.channel.id
      : null;
  const otherChannels = channels.filter((c) => !c.is_member);
  const showOnlyMine = myChannelsByDefault && !browsingChannels;
  // The open channel stays listed even before joining it, so the row for what
  // is on screen never disappears.
  const listedChannels = showOnlyMine
    ? channels.filter((c) => c.is_member || c.id === selectedChannelId)
    : channels;

  // Messages has no search input; clear any query carried over from another
  // page so it can't silently filter the conversation lists below.
  useEffect(() => {
    setSearchQuery("");
  }, [setSearchQuery]);

  return (
    <aside className="user-list">
      {/* Your own presence-status picker sits at the very top. */}
      <StatusSelector myUserId={myUserId} />

      {/* Active conversations (Unread + Recent) sit above the channels so the
          chats you're in the middle of are the first thing you see. Recent now
          interleaves DMs and the channels you're active in, by last activity. */}
      <RecentConversations
        users={users}
        channels={channels}
        selectedConversation={selectedConversation}
        summary={summary}
        presence={presence}
        onSelectUser={onSelectUser}
        onSelectChannel={onSelectChannel}
      />

      <div className="conversation-section-header">
        <span className="conversation-section-title">Channels</span>
        <button
          type="button"
          className="new-channel-btn"
          onClick={onToggleCreateChannel}
          aria-label="Add channel"
          data-tooltip="Add channel"
        >
          +
        </button>
      </div>

      {creatingChannel && (
        <ChannelCreateForm
          channelName={channelName}
          visibility={channelVisibility}
          canChooseVisibility={canChooseVisibility}
          error={channelError}
          onChannelNameChange={onChannelNameChange}
          onVisibilityChange={onChannelVisibilityChange}
          onCancel={onCancelCreateChannel}
          onCreate={onCreateChannel}
        />
      )}

      <ChannelList
        channels={listedChannels}
        selectedConversation={selectedConversation}
        onSelect={onSelectChannel}
        onJoin={onJoinChannel}
      />

      {showOnlyMine && listedChannels.length === 0 && (
        <p className="conversation-empty">You're not in any channels yet.</p>
      )}

      {myChannelsByDefault && otherChannels.length > 0 && (
        <button
          type="button"
          className="conversation-browse-btn"
          onClick={() => setBrowsingChannels((open) => !open)}
          aria-expanded={browsingChannels}
        >
          {browsingChannels
            ? "Show only my channels"
            : `Browse channels (${otherChannels.length} more)`}
        </button>
      )}

      <div className="conversation-section-header">
        <span className="conversation-section-title">Users</span>
        <button
          type="button"
          className="new-channel-btn"
          onClick={() => setStartingChat((open) => !open)}
          aria-label="Message someone by email"
          data-tooltip="Message someone by email"
        >
          +
        </button>
      </div>

      {startingChat && (
        <StartChatForm
          myUserId={myUserId}
          users={users}
          onFound={(user) => {
            setStartingChat(false);
            onStartChat(user);
          }}
          onCancel={() => setStartingChat(false)}
        />
      )}

      <PersonalChatList
        users={users}
        selectedConversation={selectedConversation}
        onSelect={onSelectUser}
        summary={summary}
        presence={presence}
        section="people"
      />
    </aside>
  );
}
