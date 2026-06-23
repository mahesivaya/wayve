import type { ChatChannel } from "../../api/chat";
import type { Conversation } from "../types";

type Props = {
  channels: ChatChannel[];
  selectedConversation: Conversation | null;
  onSelect: (channel: ChatChannel) => void;
  onJoin: (channel: ChatChannel) => void;
};

export default function ChannelList({
  channels,
  selectedConversation,
  onSelect,
  onJoin,
}: Props) {
  return (
    <>
      {channels.map((channel) => (
        <button
          key={channel.id}
          type="button"
          className={`conversation-item ${
            selectedConversation?.type === "channel" &&
            selectedConversation.channel.id === channel.id
              ? "active"
              : ""
          }`}
          onClick={() => onSelect(channel)}
        >
          <span className="conversation-icon">#</span>
          <span className="conversation-main">
            <span className="conversation-name">{channel.name}</span>
            <span className="conversation-meta">
              {channel.visibility} group · {channel.member_emails.length}{" "}
              members
              {channel.invite_emails?.length
                ? `, ${channel.invite_emails.length} invited`
                : ""}
            </span>
          </span>
          {!channel.is_member && (
            <span
              className={`channel-join-chip ${channel.join_status === "pending" ? "pending" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (channel.join_status !== "pending") {
                  onJoin(channel);
                }
              }}
            >
              {channel.join_status === "pending"
                ? "Pending"
                : channel.visibility === "public"
                  ? "Join"
                  : "Request"}
            </span>
          )}
        </button>
      ))}
    </>
  );
}
