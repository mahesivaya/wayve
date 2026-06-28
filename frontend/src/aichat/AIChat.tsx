import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import "./aichat.css";

import { sendAiChat, getAiProvider, type AiTurn } from "../api/ai";
import { useGlobalSearch } from "../search/SearchContext";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";

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
    return () => {
      cancelled = true;
    };
  }, []);

  // Pin the scroll to the bottom whenever new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

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

      if (!reply) {
        throw new Error("Empty reply from model");
      }

      setMessages((prev) => [...prev, { role: "model", content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const clear = () => {
    setMessages([]);
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

  return (
    <div className="ai-chat">
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

      <div className="ai-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">✨</div>
            <div className="ai-chat-empty-title">Ask anything</div>
            <div className="ai-chat-empty-hint">
              Type a message below to start chatting with {chatWith}.
            </div>
          </div>
        )}

        {visibleMessages.map((m, i) => (
          <div
            key={i}
            className={`ai-msg ${m.role === "user" ? "ai-msg-user" : "ai-msg-model"}`}
          >
            <div className="ai-msg-bubble">{m.content}</div>
          </div>
        ))}

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
    </div>
  );
}
