import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import "./aichat.css";

import {
  sendAiChat,
  getAiProvider,
  type AiTurn,
  type PendingEmail,
} from "../api/ai";
import { sendEmail, getAccounts } from "../api/email";
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

// Friendly labels for the provider ids the backend returns (mirrors the catalog
// in ai/config_handler.rs). Unknown ids fall back to the raw id.
const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  openai_compatible: "OpenAI-compatible",
};

export default function AIChat() {
  const { normalizedSearchQuery } = useGlobalSearch();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<AiTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // Email drafts the assistant proposed, each awaiting explicit confirmation.
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [accounts, setAccounts] = useState<MailboxLite[]>([]);
  const draftKey = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // An enterprise org owner OR a platform owner (both have ai:manage) can change
  // the provider — gate the shortcut exactly like the /settings/ai page does.
  const canManageAi =
    hasPermission(user, "ai:manage") &&
    (user?.current_plan?.tier === "enterprise" || user?.scope === "platform");

  const providerName = provider ? (PROVIDER_LABELS[provider] ?? provider) : null;
  const badgeText = providerName ?? "AI assistant";
  const chatWith = providerName ?? "your AI assistant";

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

  // Pin the scroll to the bottom whenever new messages or drafts arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, drafts, busy]);

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
      const proposed = (data.pending_actions ?? []).filter(
        (a): a is PendingEmail => a.type === "email"
      );

      // A turn is only empty if there's neither text nor a proposed action.
      if (!reply && proposed.length === 0) {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

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
  const isEmpty = messages.length === 0 && drafts.length === 0;

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
      <div className="ai-draft-row">
        <span>Subject</span>
        <div className="ai-draft-val">{d.subject}</div>
      </div>
      <div className="ai-draft-body">{d.body}</div>
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
        placeholder="Message AI…  (Enter to send, Shift+Enter for newline)"
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
        title="Send"
      >
        {busy ? "…" : "Send"}
      </button>
    </div>
  );

  return (
    <div className={`ai-chat${isEmpty ? " is-empty" : ""}`}>
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
              title="Change the AI provider for your organization"
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

      {isEmpty ? (
        <div className="ai-chat-stage">
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">✨</div>
            <div className="ai-chat-empty-title">Ask anything</div>
            <div className="ai-chat-empty-hint">
              Type a message below to start chatting with {chatWith}.
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
                <div className="ai-msg-bubble">{m.content}</div>
              </div>
            ))}

            {!normalizedSearchQuery && draftCards}

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
