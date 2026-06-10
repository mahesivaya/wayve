import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  addChatChannelUsers,
  approveChatChannelJoinRequest,
  createChatChannel,
  getChannelMessages,
  getChannelThread,
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
import ThreadPanel from "./components/ThreadPanel";
import { useResizableWidth } from "../components/useResizableWidth";
import { useChatConversations } from "./hooks/useChatConversations";
import { useChatSocket } from "./hooks/useChatSocket";
import {
  decryptChatContent,
  decryptChatMessages,
  encryptChatContent,
} from "./e2ee";
import { loadPublicKey } from "../crypto/keyStore";
import CallOverlays from "../call/CallOverlays";
import { useCallSession } from "../call/useCallSession";
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

  const {
    users,
    channels,
    setChannels,
    refreshChannels: fetchChannels,
  } = useChatConversations(user?.id);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [isNarrow, setIsNarrow] = useState(false);

  const [creatingChannel, setCreatingChannel] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] =
    useState<ChannelVisibility>("public");
  const [channelError, setChannelError] = useState("");

  // Thread side panel state. `activeThread` is the parent message the user
  // clicked "Reply in thread" on; `threadReplies` is the decrypted list of
  // replies under it. WS messages with parent_message_id matching the active
  // thread get routed here; replies for other parents only bump reply_count
  // on the corresponding main-feed message and otherwise stay hidden.
  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);
  const [threadReplies, setThreadReplies] = useState<ChatMessage[]>([]);
  // Reset thread state when the user navigates to a different conversation.
  // Tracked via a "previous value" state read during render so React can
  // bail out of the stale render and re-run with the cleared values in the
  // same pass — the equivalent of an effect that does the same thing
  // without the extra commit / cascading render (see react.dev:
  // "You Might Not Need an Effect → Adjusting state when a prop changes").
  const [lastResetFor, setLastResetFor] = useState<Conversation | null>(
    selectedConversation
  );
  // Surfaced inline above the composer when a send fails (typically because
  // a channel member hasn't finished encryption setup). Distinct from
  // `settingsError`, which lives behind the channel-settings panel and is
  // invisible to a user who's just trying to send. Declared early so the
  // conversation-change block below can reset it.
  const [composeError, setComposeError] = useState("");
  if (lastResetFor !== selectedConversation) {
    setLastResetFor(selectedConversation);
    setActiveThread(null);
    setThreadReplies([]);
    setComposeError("");
  }

  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [subjectDraft, setSubjectDraft] = useState("");
  const [visibilityDraft, setVisibilityDraft] =
    useState<ChannelVisibility>("private");
  const [addUserRole, setAddUserRole] = useState<ChannelRole>("user");
  const [addUserEmails, setAddUserEmails] = useState("");

  const selectedRef = useRef<Conversation | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Drag-resizable sidebar: the user drags the divider between the
  // channels/people list and the message area to trade width between them.
  // Persisted; clamped 200–640px. Shared useResizableWidth hook.
  const { width: sidebarWidth, startResize: startSidebarDrag } =
    useResizableWidth({
      storageKey: "rwayve.chatSidebar.width",
      defaultWidth: 320,
      min: 200,
      max: 640,
    });

  const selectedChannel =
    selectedConversation?.type === "channel"
      ? selectedConversation.channel
      : null;
  const selectedTitle = useMemo(
    () => getConversationTitle(selectedConversation),
    [selectedConversation]
  );
  const isSelectedChannelAdmin = isChannelAdmin(selectedChannel, user);
  const canChatInSelectedChannel =
    !selectedChannel || selectedChannel.is_member;

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

  const appendRealtimeMessage = useCallback(
    async (msg: ChatMessage) => {
      if (!user) return;

      const decrypted = {
        ...msg,
        content: await decryptChatContent(msg.content, user.id),
      };

      // Self-echo reconciliation: the broadcast carries the same client_id we
      // generated on send, so we patch the optimistic local copy with the real
      // server-assigned message_id (and refreshed created_at) instead of
      // appending a duplicate. The reply_count bump on the parent was already
      // done optimistically in sendThreadReply, so we deliberately do not bump
      // again here.
      if (decrypted.sender_id === user.id && decrypted.client_id) {
        if (decrypted.parent_message_id != null) {
          setThreadReplies((prev) =>
            prev.map((r) =>
              r.client_id === decrypted.client_id
                ? {
                    ...r,
                    message_id: decrypted.message_id,
                    created_at: decrypted.created_at,
                  }
                : r
            )
          );
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.client_id === decrypted.client_id
                ? {
                    ...m,
                    message_id: decrypted.message_id,
                    created_at: decrypted.created_at,
                  }
                : m
            )
          );
        }
        return;
      }

      // Threaded reply from someone else: keep it out of the main feed
      // entirely. If the matching thread is open, append it to the panel;
      // either way, bump the parent's reply_count so the "N replies →"
      // indicator updates live.
      if (decrypted.parent_message_id != null) {
        setThreadReplies((prev) =>
          activeThread?.message_id === decrypted.parent_message_id
            ? [...prev, decrypted]
            : prev
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.message_id === decrypted.parent_message_id
              ? { ...m, reply_count: (m.reply_count ?? 0) + 1 }
              : m
          )
        );
        return;
      }

      setMessages((prev) => [...prev, decrypted]);
    },
    [user, activeThread]
  );

  // Reconnect resync (Tier 2): whenever the socket (re)opens, backfill any
  // messages the open conversation missed while it was down — fetch everything
  // newer than the highest message id we already hold, then merge deduped by
  // message_id. Without this, messages sent during a drop are lost until the
  // user reselects the conversation.
  const resyncSelectedConversation = useCallback(async () => {
    const convo = selectedRef.current;
    if (!user || !convo) return;
    try {
      const lastId = messages.reduce(
        (max, m) =>
          m.message_id != null && m.message_id > max ? m.message_id : max,
        0
      );
      const since = lastId > 0 ? lastId : undefined;
      let missed: ChatMessage[] = [];
      if (convo.type === "user") {
        missed = await getChatMessages(user.id, convo.user.id, since);
      } else if (convo.type === "channel") {
        missed = await getChannelMessages(convo.channel.id, since);
      }
      if (!missed.length) return;
      const decrypted = await decryptChatMessages(missed, user.id);
      setMessages((prev) => {
        const seen = new Set(
          prev.map((m) => m.message_id).filter((id): id is number => id != null)
        );
        const additions = decrypted.filter(
          (m) => m.message_id == null || !seen.has(m.message_id)
        );
        return additions.length ? [...prev, ...additions] : prev;
      });
    } catch (err) {
      logger.error("chat resync failed", err);
    }
  }, [user, messages]);

  // A `status_update` WS event advances a sent message's delivery tick
  // (sent → delivered → read). Patch the matching bubble in place, only ever
  // upgrading — a late 'delivered' must not clobber a 'read' that already won.
  const handleStatusUpdate = useCallback(
    (messageId: number, status: ChatMessage["status"]) => {
      const rank: Record<string, number> = { sent: 0, delivered: 1, read: 2 };
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === messageId &&
          (rank[status] ?? 0) > (rank[m.status] ?? 0)
            ? { ...m, status }
            : m
        )
      );
    },
    []
  );

  const {
    wsRef,
    isConnected: isChatSocketConnected,
    isReconnecting: isChatSocketReconnecting,
  } = useChatSocket(
    user,
    selectedRef,
    appendRealtimeMessage,
    resyncSelectedConversation,
    handleStatusUpdate
  );

  // The 1:1 call entry point lives in [ChatHeader](./components/ChatHeader.tsx).
  // useCallSession owns the /ws/call socket and the peer-connection lifecycle;
  // [CallOverlays](../call/CallOverlays.tsx) renders banners + the active
  // panel in the chat-area so users see incoming calls without leaving /chat.
  const callSession = useCallSession(user?.id ?? null, user?.email);
  const selectedUser =
    selectedConversation?.type === "user" ? selectedConversation.user : null;
  const callDisabled =
    !callSession.connected || callSession.callState.kind !== "idle";
  const onAudioCall = selectedUser
    ? () => callSession.startCall(selectedUser.id, selectedUser.email, "audio")
    : null;
  const onVideoCall = selectedUser
    ? () => callSession.startCall(selectedUser.id, selectedUser.email, "video")
    : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettingsError("");
      setSubjectDraft(selectedChannel?.name ?? "");
      setVisibilityDraft(selectedChannel?.visibility ?? "private");
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [selectedChannel]);

  const openThread = async (parent: ChatMessage) => {
    if (!user || parent.message_id == null) return;
    try {
      const rawReplies = await getChannelThread(parent.message_id);
      const decryptedReplies = await decryptChatMessages(rawReplies, user.id);
      setActiveThread(parent);
      setThreadReplies(decryptedReplies);
    } catch (err) {
      logger.error("Failed to load thread", err);
    }
  };

  const closeThread = () => {
    setActiveThread(null);
    setThreadReplies([]);
  };

  // Mirrors sendMessage but pins `parent_message_id` on the WS payload so
  // the backend writes the row as a thread reply. Optimistic local state:
  // append decrypted reply + bump the parent's reply_count in the main feed
  // (the WS echo for own messages is filtered out by useChatSocket).
  const sendThreadReply = async (text: string) => {
    if (!wsRef.current || !user || !activeThread || !selectedConversation)
      return;
    if (selectedConversation.type !== "channel") return;
    if (wsRef.current.readyState !== WebSocket.OPEN) return;
    if (activeThread.message_id == null) return;

    const plaintext = text.trim();
    if (!plaintext) return;

    let encryptedContent: string;
    try {
      const recipientKeys = await recipientPublicKeysFor(selectedConversation);
      if (!recipientKeys || recipientKeys.size === 0) {
        throw new Error("No chat encryption keys are available");
      }
      encryptedContent = await encryptChatContent(plaintext, recipientKeys);
    } catch (err) {
      logger.error("Thread reply encryption failed", err);
      return;
    }

    const parentId = activeThread.message_id;
    const message: ChatMessage = {
      sender_id: user.id,
      content: encryptedContent,
      status: "sent",
      created_at: new Date().toISOString(),
      channel_id: selectedConversation.channel.id,
      parent_message_id: parentId,
      client_id: crypto.randomUUID(),
    };

    wsRef.current.send(JSON.stringify(message));
    setThreadReplies((prev) => [...prev, { ...message, content: plaintext }]);
    setMessages((prev) =>
      prev.map((m) =>
        m.message_id === parentId
          ? { ...m, reply_count: (m.reply_count ?? 0) + 1 }
          : m
      )
    );
  };

  const refreshChannels = async (activeChannelId?: number) => {
    const channelData = await fetchChannels();

    if (!activeChannelId) return;
    const activeChannel = channelData.find(
      (channel) => channel.id === activeChannelId
    );
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
      throw new Error(
        "Your chat encryption key is not available on this device"
      );
    }
    keys.set(user.id, currentUserPublicKey);

    if (conversation.type === "user") {
      if (conversation.user.public_key?.length) {
        keys.set(conversation.user.id, conversation.user.public_key);
      } else {
        throw new Error(
          `${conversation.user.email} has no chat encryption key`
        );
      }
      return keys;
    }

    const missingEmails: string[] = [];
    for (const memberId of conversation.channel.member_ids) {
      if (memberId === user.id) continue;
      const member = users.find((candidate) => candidate.id === memberId);
      if (member?.public_key?.length) {
        keys.set(memberId, member.public_key);
      } else {
        missingEmails.push(member?.email ?? `user #${memberId}`);
      }
    }

    if (missingEmails.length > 0) {
      const list = missingEmails.join(", ");
      throw new Error(
        `Can't send — ${list} ${missingEmails.length === 1 ? "hasn't" : "haven't"} ` +
          `finished encryption setup. Ask them to log out and back in once.`
      );
    }

    return keys;
  };

  const sendMessage = async () => {
    if (!wsRef.current || !user || !selectedConversation || !input.trim())
      return;
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
      setComposeError(
        err instanceof Error ? err.message : "Chat encryption failed"
      );
      return;
    }

    const message: ChatMessage = {
      sender_id: user.id,
      content: encryptedContent,
      status: "sent",
      created_at: new Date().toISOString(),
      client_id: crypto.randomUUID(),
      ...(selectedConversation.type === "channel"
        ? { channel_id: selectedConversation.channel.id }
        : { receiver_id: selectedConversation.user.id }),
    };

    wsRef.current.send(JSON.stringify(message));
    setMessages((prev) => [...prev, { ...message, content: plaintext }]);
    setInput("");
    setComposeError("");
  };

  const createChannel = async () => {
    setChannelError("");

    try {
      const channel = await createChatChannel(
        channelName,
        "user",
        [],
        channelVisibility
      );
      setChannels((prev) => [channel, ...prev]);
      setChannelName("");
      setChannelVisibility("public");
      setCreatingChannel(false);
      await loadChannelMessages(channel);
    } catch (err) {
      setChannelError(
        err instanceof Error ? err.message : "Failed to create channel"
      );
    }
  };

  const joinChannel = async (channel: ChatChannel) => {
    setSettingsError("");
    setChannelError("");

    try {
      await joinChatChannel(channel.id);
      await refreshChannels(channel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to join channel"
      );
    }
  };

  const saveSubject = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await updateChatChannelSubject(selectedChannel.id, subjectDraft);
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to update subject"
      );
    }
  };

  const saveVisibility = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await updateChatChannelVisibility(selectedChannel.id, visibilityDraft);
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to update visibility"
      );
    }
  };

  const addUsers = async () => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await addChatChannelUsers(
        selectedChannel.id,
        addUserRole,
        parseEmails(addUserEmails)
      );
      setAddUserRole("user");
      setAddUserEmails("");
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to add users"
      );
    }
  };

  const deleteUser = async (email: string) => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await removeChatChannelUser(
        selectedChannel.id,
        email.replace(" invited", "")
      );
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to delete user"
      );
    }
  };

  const approveJoinRequest = async (userId: number) => {
    if (!selectedChannel) return;
    setSettingsError("");

    try {
      await approveChatChannelJoinRequest(
        asChannelId(selectedChannel.id),
        asUserId(userId)
      );
      await refreshChannels(selectedChannel.id);
    } catch (err) {
      setSettingsError(
        err instanceof Error ? err.message : "Failed to approve request"
      );
    }
  };

  const filteredChannels = normalizedSearchQuery
    ? channels.filter((channel) =>
        [channel.name, channel.visibility, ...channel.member_emails]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
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
            : (selectedConversation?.user.email ?? ""),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : messages;

  return (
    <div
      ref={containerRef}
      className={`chat-container${isNarrow ? " narrow" : ""}${
        selectedConversation ? " has-active" : ""
      }`}
      style={{ "--chat-sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <ConversationSidebar
        users={filteredUsers}
        channels={filteredChannels}
        selectedConversation={selectedConversation}
        creatingChannel={creatingChannel}
        channelName={channelName}
        channelVisibility={channelVisibility}
        channelError={channelError}
        onToggleCreateChannel={() => setCreatingChannel((open) => !open)}
        onChannelNameChange={setChannelName}
        onChannelVisibilityChange={setChannelVisibility}
        onCancelCreateChannel={() => setCreatingChannel(false)}
        onCreateChannel={createChannel}
        onSelectChannel={loadChannelMessages}
        onJoinChannel={joinChannel}
        onSelectUser={loadUserMessages}
      />

      {/* Drag to trade width between the sidebar and the message area. */}
      <div
        className="chat-sidebar-resizer"
        onPointerDown={startSidebarDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat sidebar"
      />

      <section className="chat-area">
        <ChatHeader
          title={selectedTitle}
          selectedChannel={selectedChannel}
          settingsOpen={channelSettingsOpen}
          onAudioCall={onAudioCall}
          onVideoCall={onVideoCall}
          callDisabled={callDisabled}
          onBack={() => setSelectedConversation(null)}
          onToggleSettings={() => setChannelSettingsOpen((open) => !open)}
          onJoinChannel={joinChannel}
        />

        <CallOverlays session={callSession} />

        <div
          className={`chat-content-row${
            channelSettingsOpen ? " settings-open" : ""
          }${activeThread ? " thread-open" : ""}`}
        >
          <MessageThread
            messages={filteredMessages}
            selectedChannel={selectedChannel}
            currentUserId={user?.id}
            onOpenThread={
              selectedChannel ? (msg) => void openThread(msg) : null
            }
          />

          {selectedChannel && activeThread && (
            <ThreadPanel
              parent={activeThread}
              replies={threadReplies}
              currentUserId={user?.id}
              isConnected={isChatSocketConnected}
              onClose={closeThread}
              onSendReply={sendThreadReply}
            />
          )}

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
          isReconnecting={isChatSocketReconnecting}
          title={selectedTitle}
          input={input}
          onInputChange={(value) => {
            setInput(value);
            if (composeError) setComposeError("");
          }}
          onSend={() => {
            void sendMessage();
          }}
          error={composeError}
          onDismissError={() => setComposeError("")}
        />
      </section>
    </div>
  );
}
