import type {
  ChatChannel,
  ChatConversationSummary,
  ChatUser,
} from "../../api/chat";
import { useGlobalSearch } from "../../search/SearchContext";
import type { ChannelVisibility, Conversation } from "../types";
import ChannelCreateForm from "./ChannelCreateForm";
import ChannelList from "./ChannelList";
import PersonalChatList from "./PersonalChatList";

type Props = {
  users: ChatUser[];
  channels: ChatChannel[];
  selectedConversation: Conversation | null;
  creatingChannel: boolean;
  channelName: string;
  channelVisibility: ChannelVisibility;
  channelError: string;
  onToggleCreateChannel: () => void;
  onChannelNameChange: (value: string) => void;
  onChannelVisibilityChange: (value: ChannelVisibility) => void;
  onCancelCreateChannel: () => void;
  onCreateChannel: () => void;
  onSelectChannel: (channel: ChatChannel) => void;
  onJoinChannel: (channel: ChatChannel) => void;
  onSelectUser: (user: ChatUser) => void;
  summary: ChatConversationSummary;
};

export default function ConversationSidebar({
  users,
  channels,
  selectedConversation,
  creatingChannel,
  channelName,
  channelVisibility,
  channelError,
  onToggleCreateChannel,
  onChannelNameChange,
  onChannelVisibilityChange,
  onCancelCreateChannel,
  onCreateChannel,
  onSelectChannel,
  onJoinChannel,
  onSelectUser,
  summary,
}: Props) {
  const { searchQuery, setSearchQuery } = useGlobalSearch();

  return (
    <aside className="user-list">
      {/* Chat search lives at the top of the sidebar (above Recent) rather than
          in the global header. Drives the same global query that filters the
          channels / users / messages below. */}
      <div className="global-search-box chat-sidebar-search">
        <span className="global-search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search"
        />
        {searchQuery && (
          <button
            type="button"
            className="global-search-clear"
            onClick={() => setSearchQuery("")}
            title="Clear search"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Active conversations (Unread + Recent) sit above the channels so the
          chats you're in the middle of are the first thing you see. */}
      <PersonalChatList
        users={users}
        selectedConversation={selectedConversation}
        onSelect={onSelectUser}
        summary={summary}
        section="recent"
      />

      <div className="conversation-section-header">
        <span className="conversation-section-title">Channels</span>
        <button
          type="button"
          className="new-channel-btn"
          onClick={onToggleCreateChannel}
          aria-label="Add channel"
          title="Add channel"
        >
          +
        </button>
      </div>

      {creatingChannel && (
        <ChannelCreateForm
          channelName={channelName}
          visibility={channelVisibility}
          error={channelError}
          onChannelNameChange={onChannelNameChange}
          onVisibilityChange={onChannelVisibilityChange}
          onCancel={onCancelCreateChannel}
          onCreate={onCreateChannel}
        />
      )}

      <ChannelList
        channels={channels}
        selectedConversation={selectedConversation}
        onSelect={onSelectChannel}
        onJoin={onJoinChannel}
      />

      <PersonalChatList
        users={users}
        selectedConversation={selectedConversation}
        onSelect={onSelectUser}
        summary={summary}
        section="people"
      />
    </aside>
  );
}
