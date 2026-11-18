import { useEffect, useRef, useState } from "react";
import {
  emailAssist,
  type EmailAssistAction,
  type EmailAssistOriginal,
} from "../api/emailAssist";

// The AI row under an email editor: tidy what was typed (grammar, wording,
// length, tone) or, in a reply, draft the answer to the email being read.
//
// The result replaces the editor's text, with one step of undo. Nothing is
// sent anywhere but the AI provider, and nothing is sent as an email: the
// writer still reads the text and presses Send.

type Props = {
  // The editor's current text, and how to replace it.
  text: string;
  onApply: (next: string) => void;
  // The email being answered. Present only in a reply, where it adds "Write a
  // reply"; its body is empty until the message has loaded.
  original?: EmailAssistOriginal;
  // Set when AI must not be used here (an end-to-end encrypted send); shown in
  // place of the buttons.
  offReason?: string;
};

// The sender's display name without their address: "Asha Rao <asha@x.io>"
// gives "Asha Rao", a bare address gives nothing. The address is personal data
// the model has no use for, so it never leaves the browser. The server strips
// it again, so this is not the only guard.
function senderName(from: string): string {
  const name = from
    .split("<")[0]
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  return name.includes("@") ? "" : name;
}

const REWRITES: { action: EmailAssistAction; label: string }[] = [
  { action: "fix_grammar", label: "Fix grammar" },
  { action: "improve", label: "Improve" },
  { action: "shorter", label: "Shorter" },
  { action: "formal", label: "More formal" },
];

export default function AiAssistBar({
  text,
  onApply,
  original,
  offReason,
}: Props) {
  const [busy, setBusy] = useState<EmailAssistAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last change made here: what the AI wrote and what it replaced. Undo is
  // offered only while the editor still holds exactly what the AI wrote.
  const [applied, setApplied] = useState<{
    result: string;
    previous: string;
  } | null>(null);

  // The text as it is now, for the moment an answer comes back: if the writer
  // kept typing meanwhile, their words win and the answer is dropped.
  const latestText = useRef(text);
  useEffect(() => {
    latestText.current = text;
  }, [text]);

  if (offReason) {
    return (
      <div className="ai-assist-bar ai-assist-off">
        <span className="ai-assist-label">✨ AI</span>
        <span className="ai-assist-note">{offReason}</span>
      </div>
    );
  }

  const run = async (action: EmailAssistAction) => {
    if (busy) return;
    const sent = text;
    setBusy(action);
    setError(null);
    try {
      const { text: result } = await emailAssist({
        action,
        text: sent,
        ...(action === "reply" && original
          ? { original: { ...original, from: senderName(original.from) } }
          : {}),
      });
      if (latestText.current !== sent) {
        setError(
          "You kept typing, so the AI's version wasn't applied. Try again."
        );
        return;
      }
      setApplied({ result, previous: sent });
      onApply(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The AI request failed.");
    } finally {
      setBusy(null);
    }
  };

  const hasText = text.trim().length > 0;
  const canUndo = applied !== null && applied.result === text;

  return (
    <div className="ai-assist-bar">
      <span className="ai-assist-label">✨ AI</span>
      {original && (
        <button
          type="button"
          className="ai-assist-btn ai-assist-primary"
          onClick={() => void run("reply")}
          disabled={busy !== null || !original.body.trim()}
          title={
            hasText
              ? "Turn what you typed into a full reply to this email"
              : "Draft a reply to this email"
          }
        >
          {busy === "reply" ? "Writing…" : "Write a reply"}
        </button>
      )}
      {REWRITES.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          className="ai-assist-btn"
          onClick={() => void run(action)}
          disabled={busy !== null || !hasText}
          title={hasText ? undefined : "Type something first"}
        >
          {busy === action ? "Working…" : label}
        </button>
      ))}
      {canUndo && (
        <button
          type="button"
          className="ai-assist-undo"
          onClick={() => {
            onApply(applied.previous);
            setApplied(null);
          }}
        >
          Undo
        </button>
      )}
      {error && (
        <span className="ai-assist-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
