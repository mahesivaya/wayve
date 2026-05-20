import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  addChatChannelUsers,
  approveChatChannelJoinRequest,
  createChatChannel,
  getChannelMessages,
  getChatMessages,
  joinChatChannel,
  removeChatChannelUser,
  type ChatChannel,
  type ChatMessage,
  type ChatUser,
  updateChatChannelSubject,
  updateChatChannelVisibility,
} from "../api/chat";
import { useGlobalSearch } from "../search/SearchContext";
import { asChannelId, asUserId } from "../types/brand";
import { logger } from "../utils/logger";
import ChatHeader from "./components/ChatHeader";
import ChannelSettingsPanel from "./components/ChannelSettingsPanel";
import ConversationSidebar from "./components/ConversationSidebar";
import MessageComposer from "./components/MessageComposer";
import MessageThread from "./components/MessageThread";
import { useChatConversations } from "./hooks/useChatConversations";
import { useChatSocket } from "./hooks/useChatSocket";
import {
  decryptChatContent,
  decryptChatMessages,
  encryptChatContent,
} from "./e2ee";
import { loadPublicKey } from "../crypto/keyStore";
import type { ChannelRole, ChannelVisibility, Conversation } from "./types";
import {
  getChannelAdmins,
  getChannelUsers,
  getConversationTitle,
  isChannelAdmin,
  parseEmails,
} from "./utils";
import "./chat.css";

export default function Chat() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();

  const { users, channels, setChannels, refreshChannels: fetchChannels } =
    useChatConversations(user?.id);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [isNarrow, setIsNarrow] = useState(false);

  const [creatingChannel, setCreatingChannel] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [inviteRole, setInviteRole] = useState<ChannelRole>("user");
  const [inviteEmails, setInviteEmails] = useState("");
  const [channelError, setChannelError] = useState("");

  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [subjectDraft, setSubjectDraft] = useState("");
  const [visibilityDraft, setVisibilityDraft] = useState<ChannelVisibility>("private");
  const [addUserRole, setAddUserRole] = useState<ChannelRole>("user");
  const [addUserEmails, setAddUserEmails] = useState("");

  const selectedRef = useRef<Conversation | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedChannel =
    selectedConversation?.type === "channel" ? selectedConversation.channel : null;
  const selectedTitle = useMemo(
    () => getConversationTitle(selectedConversation),
    [selectedConversation],
  );
  const isSelectedChannelAdmin = isChannelAdmin(selectedChannel, user);
  const canChatInSelectedChannel = !selectedChannel || selectedChannel.is_member;

  useEffect(() => {
    selectedRef.current = selectedConversation;
  }, [selectedConversation]);

  // Collapse to a single pane (list OR conversation) when the chat area is too
  // narrow for both. Width is observed on the container, not the window, since
  // chat can render inside a split pane.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const narrow = entry.contentRect.width < 760;
        setIsNarrow((prev) => (prev !== narrow ? narrow : prev));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const appendRealtimeMessage = useCallback(async (msg: ChatMessage) => {
    if (!user) return;

    const decrypted = {
      ...msg,
      content: await decryptChatContent(msg.content, user.id),
    };
    setMessages((prev) => [...prev, decrypted]);
  }, [user]);

  const { wsRef, isConnected: isChatSocketConnected } = useChatSocket(
    user,
    selectedRef,
    appendRealtimeMessage,
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettingsError("");
      setSubjectDraft(selectedChannel?.name ?? "");
      setVisibilityDraft(selectedChannel?.visibility ?? "private");
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [selectedChannel]);

  const refreshChannels = async (activeChannelId?: number) => {
    const channelData = await fetchChannels();

    if (!activeChannelId) return;
    const activeChannel = channelData.find((channel) => channel.id === activeChannelId);
    if (activeChannel) {
      setSelectedConversation({ type: "channel", channel: activeChannel });
    }
  };

  const loadUserMessages = async (otherUser: ChatUser) => {
    if (!user) return;

    try {
      const rawMessages = await getChatMessages(user.id, otherUser.id);
      setMessages(await decryptChatMessages(rawMessages, user.id));
      setSelectedConversation({ type: "user", user: otherUser });
      setChannelSettingsOpen(false);
    } catch (err) {
      logger.error("Failed to load messages", err);
    }
  };

  const loadChannelMessages = async (channel: ChatChannel) => {
    if (!user) return;

    if (!channel.is_member) {
      setMessages([]);
      setSelectedConversation({ type: "channel", channel });
      setChannelSettingsOpen(false);
      return;
    }

    try {
      const rawMessages = await getChannelMessages(channel.id);
      setMessages(await decryptChatMessages(rawMessages, user.id));
      setSelectedConversation({ type: "channel", channel });
      setChannelSettingsOpen(false);
    } catch (err) {
      logger.error("Failed to load channel messages", err);
    }
  };

  const recipientPublicKeysFor = async (conversation: Conversation) => {
    if (!user) return null;

    const keys = new Map<number, number[] | ArrayBuffer | Uint8Array>();
    const currentUserPublicKey = await loadPublicKey(user.id);
    if (!currentUserPublicKey) {
      throw new Error("Your chat encryption key is not available on this device");
    }
    keys.set(user.id, currentUserPublicKey);

    if (conversation.type === "user") {
      if (conversation.user.public_key?.length) {
        keys.set(conversation.user.id, conversation.user.public_key);
      } else {
        throw new Error(`${conversation.user.email} has no chat encryption key`);
      }
      return keys;
    }

    const missingMembers: number[] = [];
    for (const memberId of conversation.channel.member_ids) {
      if (memberId === user.id) continue;
      const member = users.find((candidate) => candidate.id === memberId);
      if (member?.public_key?.length) {
        keys.set(memberId, member.public_key);
      } else {
        missingMembers.push(memberId);
      }
    }

    if (missingMembers.length > 0) {
      throw new Error("Some channel members do not have chat encryption keys");
    }

    return keys;
  };

  const sendMessage = async () => {
    if (!wsRef.current || !user || !selectedConversation || !input.trim()) return;
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      logger.warn("Chat socket not ready; message send skipped", {
        readyState: wsRef.current.readyState,
      });
      return;
    }

    const plaintext = input.trim();
    let encryptedContent: string;

    try {
      const recipientKeys = await recipientPublicKeysFor(selectedConversation);
      if (!recipientKeys || recipientKeys.size === 0) {
        throw new Error("No chat encryption keys are available");
      }
      encryptedContent = await encryptChatContent(plaintext, recipientKeys);
    } catch (err) {
      logger.error("Chat encryption failed", err);
      setSettingsError(err instanceof Error ? err.message : "Chat encryption failed");
      return;
    }

    const message: ChatMessage = {
      sender_id: user.id,
      content: encryptedContent,
      status: "sent",
      created_at: new Date().toISOString(),
      ...(selectedConversation.type === "channel"
        ? { channel_id: selectedConversation.channel.id }
        : { receiver_id: selectedConversation.user.id }),
    };

    wsRef.current.send(JSON.stringify(message));
    setMessages((prev) => [...prev, { ...message, content: plaintext }]);
    setInput("");
  };

  const createChannel = async () => {
    setChannelError("");

    try {
      const channel = await createChatChannel(
        channelName,
        inviteRole,
        parseEmails(inviteEmails),
      );
      setChannels((prev) => [channel, ...prev]);
      setChannelName("");
      setInviteRole("user");
      setInviteEmails("");
      setCreatingChannel(false);
      await loadChannelMessages(channel);
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : "Failed to create channel");
    }
  };

  const joinChannel = async (channel: ChatChannel) => {
    setSettingsError("");
    setChannelError("");

    try {
      await joinChatChannel(channel.id);
      await refreshChannels(channel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to join channel");
    }
  };

  const saveSubject = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await updateChatChannelSubject(selectedChannel.id, subjectDraft);
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to update subject");
    }
  };

  const saveVisibility = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await updateChatChannelVisibility(selectedChannel.id, visibilityDraft);
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to update visibility");
    }
  };

  const addUsers = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await addChatChannelUsers(selectedChannel.id, addUserRole, parseEmails(addUserEmails));
      setAddUserRole("user");
      setAddUserEmails("");
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to add users");
    }
  };

  const deleteUser = async (email: string) => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await removeChatChannelUser(selectedChannel.id, email.replace(" invited", ""));
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const approveJoinRequest = async (userId: number) => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await approveChatChannelJoinRequest(
        asChannelId(selectedChannel.id),
        asUserId(userId),
      );
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Failed to approve request");
    }
  };

  const filteredChannels = normalizedSearchQuery
    ? channels.filter((channel) =>
        [channel.name, channel.visibility, ...channel.member_emails]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery),
      )
    : channels;

  const filteredUsers = normalizedSearchQuery
    ? users.filter((u) => u.email.toLowerCase().includes(normalizedSearchQuery))
    : users;

  const filteredMessages = normalizedSearchQuery
    ? messages.filter((msg) =>
        [
          msg.content,
          msg.status,
          msg.created_at,
          selectedConversation?.type === "channel"
            ? selectedConversation.channel.name
            : selectedConversation?.user.email ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery),
      )
    : messages;

  return (
    <div
      ref={containerRef}
      className={`chat-container${isNarrow ? " narrow" : ""}${
        selectedConversation ? " has-active" : ""
      }`}
    >
      <ConversationSidebar
        users={filteredUsers}
        channels={filteredChannels}
        selectedConversation={selectedConversation}
        creatingChannel={creatingChannel}
        channelName={channelName}
        inviteRole={inviteRole}
        inviteEmails={inviteEmails}
        channelError={channelError}
        onToggleCreateChannel={() => setCreatingChannel((open) => !open)}
        onChannelNameChange={setChannelName}
        onInviteRoleChange={setInviteRole}
        onInviteEmailsChange={setInviteEmails}
        onCancelCreateChannel={() => setCreatingChannel(false)}
        onCreateChannel={createChannel}
        onSelectChannel={loadChannelMessages}
        onJoinChannel={joinChannel}
        onSelectUser={loadUserMessages}
      />

      <section className="chat-area">
        <ChatHeader
          title={selectedTitle}
          selectedChannel={selectedChannel}
          settingsOpen={channelSettingsOpen}
          onBack={() => setSelectedConversation(null)}
          onToggleSettings={() => setChannelSettingsOpen((open) => !open)}
          onJoinChannel={joinChannel}
        />

        <div
          className={`chat-content-row${
            channelSettingsOpen ? " settings-open" : ""
          }`}
        >
          <MessageThread
            messages={filteredMessages}
            selectedChannel={selectedChannel}
            currentUserId={user?.id}
          />

          {selectedChannel && channelSettingsOpen && (
            <ChannelSettingsPanel
              channel={selectedChannel}
              isAdmin={isSelectedChannelAdmin}
              admins={getChannelAdmins(selectedChannel)}
              users={getChannelUsers(selectedChannel)}
              subjectDraft={subjectDraft}
              visibilityDraft={visibilityDraft}
              addUserRole={addUserRole}
              addUserEmails={addUserEmails}
              error={settingsError}
              onSubjectDraftChange={setSubjectDraft}
              onVisibilityDraftChange={setVisibilityDraft}
              onAddUserRoleChange={setAddUserRole}
              onAddUserEmailsChange={setAddUserEmails}
              onSaveSubject={saveSubject}
              onSaveVisibility={saveVisibility}
              onDeleteUser={deleteUser}
              onAddUsers={addUsers}
              onApproveJoinRequest={approveJoinRequest}
            />
          )}
        </div>

        <MessageComposer
          conversation={selectedConversation}
          canChat={canChatInSelectedChannel}
          isConnected={isChatSocketConnected}
          title={selectedTitle}
          input={input}
          onInputChange={setInput}
          onSend={() => {
            void sendMessage();
          }}
        />
      </section>
    </div>
  );
}
