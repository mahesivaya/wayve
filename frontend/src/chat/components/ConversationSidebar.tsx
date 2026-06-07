import type { ChatChannel, ChatUser } from "../../api/chat";
import type { Conversation } from "../types";
import ChannelCreateForm from "./ChannelCreateForm";
import ChannelList from "./ChannelList";
import PersonalChatList from "./PersonalChatList";

type Props = {
  users: ChatUser[];
  channels: ChatChannel[];
  selectedConversation: Conversation | null;
  creatingChannel: boolean;
  channelName: string;
  channelError: string;
  onToggleCreateChannel: () => void;
  onChannelNameChange: (value: string) => void;
  onCancelCreateChannel: () => void;
  onCreateChannel: () => void;
  onSelectChannel: (channel: ChatChannel) => void;
  onJoinChannel: (channel: ChatChannel) => void;
  onSelectUser: (user: ChatUser) => void;
};

export default function ConversationSidebar({
  users,
  channels,
  selectedConversation,
  creatingChannel,
  channelName,
  channelError,
  onToggleCreateChannel,
  onChannelNameChange,
  onCancelCreateChannel,
  onCreateChannel,
  onSelectChannel,
  onJoinChannel,
  onSelectUser,
}: Props) {
  return (
    <aside className="user-list">
      <div className="conversation-section-header">
        <span className="conversation-section-title">Channels</span>
        <button type="button" className="new-channel-btn" onClick={onToggleCreateChannel}>
          + Add Channel
        </button>
      </div>

      {creatingChannel && (
        <ChannelCreateForm
          channelName={channelName}
          error={channelError}
          onChannelNameChange={onChannelNameChange}
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
      />
    </aside>
  );
}
