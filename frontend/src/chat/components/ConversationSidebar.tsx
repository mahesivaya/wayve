import type {
  ChatChannel,
  ChatConversationSummary,
  ChatUser,
} from "../../api/chat";
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
  return (
    <aside className="user-list">
      <div className="conversation-section-header">
        <span className="conversation-section-title">Channels</span>
        <button
          type="button"
          className="new-channel-btn"
          onClick={onToggleCreateChannel}
        >
          + Add Channel
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
      />
    </aside>
  );
}
