import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useIsPhone } from "../components/useIsNarrow";
import { useNavigate } from "react-router-dom";
import "./aichat.css";

import {
  sendAiChat,
  getAiProvider,
  type AiTurn,
  type PendingEmail,
  type PendingStatusChange,
} from "../api/ai";
import { sendEmail, getAccounts } from "../api/email";
import { applyStatusChange } from "./applyStatusChange";
import AiReply from "./AiReply";
import {
  forgetAiConversation,
  loadAiConversation,
  saveAiConversation,
} from "./conversationSession";
import { useGlobalSearch } from "../search/SearchContext";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";

// A connected mailbox, as returned by GET /api/accounts — only the fields the
// from-account selector needs.
type MailboxLite = { id: number; email: string; display_name?: string | null };

// An email the assistant drafted, awaiting the user's explicit confirmation
// before it is sent through the existing /api/emails endpoint.
type EmailDraft = PendingEmail & {
  key: number;
  accountId?: number;
  status: "pending" | "sending" | "sent" | "error";
  errorText?: string;
};

// A status change the assistant proposed for a user story or ticket, awaiting
// the same explicit confirmation before the board's update endpoint is called.
type StatusMove = PendingStatusChange & {
  cardKey: number;
  status: "pending" | "saving" | "done" | "error";
  errorText?: string;
};

// What survives a refresh: the turns and the cards still on screen.
type SavedConversation = {
  messages: AiTurn[];
  drafts: EmailDraft[];
  moves: StatusMove[];
};

// Friendly labels for the provider ids the backend returns (mirrors the catalog
// in ai/config_handler.rs). Unknown ids fall back to the raw id.
const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  openai_compatible: "OpenAI-compatible",
};

export default function AIChat({
  hideHeader = false,
}: {
  hideHeader?: boolean;
}) {
  const isPhone = useIsPhone();
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Picked up once, on mount: the conversation this user had in this tab before
  // a refresh. A send or a save the refresh cut off goes back to waiting for
  // its confirmation, since nobody knows whether it went through.
  const [restored] = useState(() =>
    loadAiConversation<SavedConversation>(user?.id)
  );
  const [messages, setMessages] = useState<AiTurn[]>(restored?.messages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // Email drafts the assistant proposed, each awaiting explicit confirmation.
  const [drafts, setDrafts] = useState<EmailDraft[]>(() =>
    (restored?.drafts ?? []).map((d) =>
      d.status === "sending" ? { ...d, status: "pending" } : d
    )
  );
  // Status changes the assistant proposed, each awaiting confirmation too.
  const [moves, setMoves] = useState<StatusMove[]>(() =>
    (restored?.moves ?? []).map((m) =>
      m.status === "saving" ? { ...m, status: "pending" } : m
    )
  );
  const [accounts, setAccounts] = useState<MailboxLite[]>([]);
  // Card keys carry on past the restored ones so a new card never reuses one.
  const draftKey = useRef(
    Math.max(
      0,
      ...(restored?.drafts ?? []).map((d) => d.key),
      ...(restored?.moves ?? []).map((m) => m.cardKey)
    )
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // An organization's owner (on any plan) or a platform owner can change the
  // provider — gate the shortcut exactly like the sidebar's /settings/ai entry.
  const canManageAi =
    hasPermission(user, "ai:manage") &&
    (user?.scope === "organization" || user?.scope === "platform");

  const providerName = provider
    ? (PROVIDER_LABELS[provider] ?? provider)
    : null;
  const badgeText = providerName ?? "AI assistant";

  // Show the real provider on load (before any message) so the header never
  // mislabels the assistant. Best-effort: on failure we keep the neutral label.
  useEffect(() => {
    let cancelled = false;
    void getAiProvider()
      .then((info) => {
        if (cancelled) return;
        setProvider(info.provider);
        setModel(info.model);
      })
      .catch(() => {});
    // The connected mailboxes power the "From" selector on a draft card. Best-
    // effort: on failure the card still sends using the draft's account_id.
    void getAccounts<MailboxLite>()
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (userId == null) return;
    if (messages.length === 0 && drafts.length === 0 && moves.length === 0) {
      forgetAiConversation();
      return;
    }
    saveAiConversation<SavedConversation>(userId, { messages, drafts, moves });
  }, [userId, messages, drafts, moves]);

  // Pin the scroll to the bottom whenever new messages or drafts arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, drafts, moves, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setInput("");

    const next: AiTurn[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);

    try {
      const data = await sendAiChat(next);
      // Keep the header in sync if the resolved provider changed (e.g. the owner
      // just switched it in /settings/ai).
      if (data.provider) setProvider(data.provider);
      if (data.model) setModel(data.model);
      const reply = (data.reply ?? "").trim();
      const actions = data.pending_actions ?? [];
      const proposed = actions.filter(
        (a): a is PendingEmail => a.type === "email"
      );
      const proposedMoves = actions.filter(
        (a): a is PendingStatusChange => a.type === "set_status"
      );

      // A turn is only empty if there's neither text nor a proposed action.
      if (!reply && proposed.length === 0 && proposedMoves.length === 0) {
        throw new Error("Empty reply from model");
      }

      if (reply) {
        setMessages((prev) => [...prev, { role: "model", content: reply }]);
      }

      if (proposed.length > 0) {
        setDrafts((prev) => [
          ...prev,
          ...proposed.map((p) => ({
            ...p,
            key: (draftKey.current += 1),
            accountId: p.account_id,
            status: "pending" as const,
          })),
        ]);
      }

      if (proposedMoves.length > 0) {
        setMoves((prev) => [
          ...prev,
          ...proposedMoves.map((p) => ({
            ...p,
            cardKey: (draftKey.current += 1),
            status: "pending" as const,
          })),
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const patchMove = (cardKey: number, patch: Partial<StatusMove>) =>
    setMoves((prev) =>
      prev.map((m) => (m.cardKey === cardKey ? { ...m, ...patch } : m))
    );

  // The ONLY place a story or ticket is actually moved: an explicit user
  // click, routed through the board's own update endpoint (so the status
  // history and audit log are written as for any other edit).
  const confirmMove = async (move: StatusMove) => {
    if (move.status === "saving" || move.status === "done") return;
    patchMove(move.cardKey, { status: "saving", errorText: undefined });
    try {
      await applyStatusChange(move);
      patchMove(move.cardKey, { status: "done" });
    } catch (err) {
      patchMove(move.cardKey, {
        status: "error",
        errorText: err instanceof Error ? err.message : "Could not move it",
      });
    }
  };

  const cancelMove = (cardKey: number) =>
    setMoves((prev) => prev.filter((m) => m.cardKey !== cardKey));

  const patchDraft = (key: number, patch: Partial<EmailDraft>) =>
    setDrafts((prev) =>
      prev.map((d) => (d.key === key ? { ...d, ...patch } : d))
    );

  // The ONLY place an email is actually sent: an explicit user click, routed
  // through the existing authenticated /api/emails endpoint. The assistant never
  // sends on its own.
  const confirmDraft = async (draft: EmailDraft) => {
    if (draft.status === "sending" || draft.status === "sent") return;
    const accountId = draft.accountId ?? accounts[0]?.id;
    if (!accountId) {
      patchDraft(draft.key, {
        status: "error",
        errorText: "Connect an email account to send.",
      });
      return;
    }
    patchDraft(draft.key, { status: "sending", errorText: undefined });
    try {
      await sendEmail({
        account_id: accountId,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
      });
      patchDraft(draft.key, { status: "sent" });
      setMessages((prev) => [
        ...prev,
        { role: "model", content: `✅ Email sent to ${draft.to}.` },
      ]);
    } catch (err) {
      patchDraft(draft.key, {
        status: "error",
        errorText: err instanceof Error ? err.message : "Send failed",
      });
    }
  };

  const cancelDraft = (key: number) =>
    setDrafts((prev) => prev.filter((d) => d.key !== key));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const clear = () => {
    setMessages([]);
    setDrafts([]);
    setMoves([]);
    setError(null);
  };

  const visibleMessages = normalizedSearchQuery
    ? messages.filter((m) =>
        [m.role, m.content]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : messages;

  // Before the conversation starts, center the intro + composer in the middle
  // of the page; once a message is sent (or a draft appears) the composer drops
  // to the bottom.
  const isEmpty =
    messages.length === 0 && drafts.length === 0 && moves.length === 0;

  const moveCards = moves.map((m) => {
    const noun = m.kind === "ticket" ? "ticket" : "user story";
    const label = m.key ? `${m.key} ${m.name}` : m.name;
    return (
      <div key={m.cardKey} className="ai-draft ai-move">
        <div className="ai-draft-head">
          <span className="ai-draft-icon">↪️</span>
          Move {noun} — review and confirm
        </div>
        <div className="ai-draft-row">
          <span>{m.kind === "ticket" ? "Ticket" : "Story"}</span>
          <div className="ai-draft-val">{label}</div>
        </div>
        <div className="ai-draft-row">
          <span>Status</span>
          <div className="ai-draft-val">
            {m.from_status} → <strong>{m.to_status_name}</strong>
          </div>
        </div>
        {m.status === "error" && (
          <div className="ai-chat-error">{m.errorText}</div>
        )}
        {m.status === "done" ? (
          <div className="ai-draft-sent">✅ Moved to {m.to_status_name}</div>
        ) : (
          <div className="ai-draft-actions">
            <button
              className="ai-draft-confirm"
              onClick={() => void confirmMove(m)}
              disabled={m.status === "saving"}
            >
              {m.status === "saving" ? "Moving…" : "Confirm move"}
            </button>
            <button
              className="ai-draft-cancel"
              onClick={() => cancelMove(m.cardKey)}
              disabled={m.status === "saving"}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  });

  const draftCards = drafts.map((d) => (
    <div key={d.key} className="ai-draft">
      <div className="ai-draft-head">
        <span className="ai-draft-icon">✉️</span>
        Draft email — review and confirm to send
      </div>
      <label className="ai-draft-row">
        <span>From</span>
        <select
          className="ai-draft-select"
          value={d.accountId ?? accounts[0]?.id ?? ""}
          disabled={d.status === "sending" || d.status === "sent"}
          onChange={(e) =>
            patchDraft(d.key, {
              accountId: Number(e.target.value) || undefined,
            })
          }
        >
          {accounts.length === 0 && (
            <option value="">No account connected</option>
          )}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name ? `${a.display_name} <${a.email}>` : a.email}
            </option>
          ))}
        </select>
      </label>
      <div className="ai-draft-row">
        <span>To</span>
        <div className="ai-draft-val">{d.to}</div>
      </div>
      <label className="ai-draft-row">
        <span>Subject</span>
        <input
          className="ai-draft-input"
          type="text"
          value={d.subject}
          placeholder="Subject"
          disabled={d.status === "sending" || d.status === "sent"}
          onChange={(e) => patchDraft(d.key, { subject: e.target.value })}
        />
      </label>
      <textarea
        className="ai-draft-body-input"
        value={d.body}
        placeholder="Write the email…"
        rows={5}
        disabled={d.status === "sending" || d.status === "sent"}
        onChange={(e) => patchDraft(d.key, { body: e.target.value })}
      />
      {d.status === "error" && (
        <div className="ai-chat-error">{d.errorText}</div>
      )}
      {d.status === "sent" ? (
        <div className="ai-draft-sent">✅ Sent to {d.to}</div>
      ) : (
        <div className="ai-draft-actions">
          <button
            className="ai-draft-confirm"
            onClick={() => void confirmDraft(d)}
            disabled={d.status === "sending"}
          >
            {d.status === "sending" ? "Sending…" : "Confirm & send"}
          </button>
          <button
            className="ai-draft-cancel"
            onClick={() => cancelDraft(d.key)}
            disabled={d.status === "sending"}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  ));

  const inputRow = (
    <div className="ai-chat-input-row">
      <textarea
        className="ai-chat-input"
        // A phone has no Enter-versus-Shift+Enter to explain, and no room for
        // the hint: it wrapped to three lines and the box cut the third off.
        placeholder={
          isPhone
            ? "Message AI…"
            : "Message AI…  (Enter to send, Shift+Enter for newline)"
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        disabled={busy}
      />
      <button
        className="ai-chat-send"
        onClick={send}
        disabled={busy || !input.trim()}
        data-tooltip="Send"
      >
        {busy ? "…" : "Send"}
      </button>
    </div>
  );

  return (
    <div className={`ai-chat${isEmpty ? " is-empty" : ""}`}>
      {/* Header (title + provider/model + actions). Hidden when embedded as the
        desktop Home surface, which wants a clean, chrome-free chat. */}
      {!hideHeader && (
        <div className="ai-chat-header">
          <div className="ai-chat-title">
            <span className="ai-chat-icon">✨</span>
            AI Chat
            <span className="ai-chat-sub">{badgeText}</span>
            {model && <span className="ai-chat-model">{model}</span>}
          </div>
          <div className="ai-chat-actions">
            {canManageAi && (
              <button
                className="ai-chat-settings"
                onClick={() => navigate("/settings/ai")}
                data-tooltip="Change the AI provider for your organization"
              >
                ⚙ AI settings
              </button>
            )}
            {messages.length > 0 && (
              <button className="ai-chat-clear" onClick={clear} disabled={busy}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {isEmpty ? (
        <div className="ai-chat-stage">
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">✨</div>
            <div className="ai-chat-empty-title">Ask anything</div>
            <div className="ai-chat-empty-hint">
              Type a message below to start chatting.
            </div>
          </div>
          {error && <div className="ai-chat-error">{error}</div>}
          {inputRow}
        </div>
      ) : (
        <>
          <div className="ai-chat-messages" ref={scrollRef}>
            {visibleMessages.map((m, i) => (
              <div
                key={i}
                className={`ai-msg ${m.role === "user" ? "ai-msg-user" : "ai-msg-model"}`}
              >
                {m.role === "model" ? (
                  <AiReply content={m.content} />
                ) : (
                  <div className="ai-msg-bubble">{m.content}</div>
                )}
              </div>
            ))}

            {!normalizedSearchQuery && draftCards}
            {!normalizedSearchQuery && moveCards}

            {busy && (
              <div className="ai-msg ai-msg-model">
                <div className="ai-msg-bubble ai-msg-typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </div>

          {error && <div className="ai-chat-error">{error}</div>}

          {inputRow}
        </>
      )}
    </div>
  );
}
