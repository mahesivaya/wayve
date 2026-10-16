import type { ChatChannel, ChatUser } from "../api/chat";

export type ChannelRole = "admin" | "user";
export type ChannelVisibility = "public" | "private";

export type Conversation =
  { type: "user"; user: ChatUser } | { type: "channel"; channel: ChatChannel };
