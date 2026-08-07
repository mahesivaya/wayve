import React, { useEffect, useRef, useState } from "react";
import {
  downloadEmailAttachment,
  sendEmail,
  getGmailConnectUrl,
  filesToAttachments,
  MAX_ATTACHMENTS_BYTES,
} from "../api/email";
import { formatFileSize } from "./renderUtils";
import { isGmailReconnectError } from "./bodyUtils";
import EmailBody from "./EmailBody";
import { EmailItem } from "./types";
import { updateEmailState, type InboxState } from "../api/sharedInboxes";
import { APP_TIME_ZONE } from "../utils/datetime";
import { useAuth } from "../auth/useAuth";
import { useMentionSearch, mentionLabel } from "./useMentionSearch";
import { avatarColor } from "../shared/avatar";
import { useShortcuts } from "../shared/useShortcuts";
import ContactAvatar from "../shared/ContactAvatar";

interface EmailDetailProps {
  selectedEmail: EmailItem | null;
  viewMode: "email" | "files";
  onBack: () => void;
  onDeleteEmail: (emailId: number) => Promise<void>;
  // Marks the email's sender as noise (routes their mail to the Noise folder).
  onMarkNoise?: (emailId: number) => Promise<void>;
  // Narrows the mail list to one sender. The host owns this because showing
  // *all* of a sender's mail means leaving the current folder, which is the
  // host's state. Omit to hide the menu entry.
  onFilterBySender?: (address: string) => void;
}

export const EmailDetail: React.FC<EmailDetailProps> = ({
  selectedEmail,
  viewMode,
  onBack,
  onDeleteEmail,
  onMarkNoise,
  onFilterBySender,
}) => {
  const { user } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Gmail-style "more actions" kebab menu (temporary placeholder items).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // Sender chip menu: copy the address, or narrow the list to this sender.
  const [senderMenuOpen, setSenderMenuOpen] = useState(false);
  const [senderCopied, setSenderCopied] = useState(false);
  const senderMenuRef = useRef<HTMLDivElement | null>(null);
  // The reading pane is the scroll container for the (auto-height) body iframe.
  // Focus it when an email opens so the first wheel/arrow-key scroll lands here
  // instead of the list row that was just clicked. See the focus effect below.
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [forwardBody, setForwardBody] = useState("");
  const [forwardSending, setForwardSending] = useState(false);
  const [forwardError, setForwardError] = useState<string | null>(null);
  // Reply and forward attachments always send via the connected mailbox, so
  // they are standard-mailbox only and never E2E.
  const [replyAttachments, setReplyAttachments] = useState<File[]>([]);
  const replyFileRef = useRef<HTMLInputElement>(null);
  // Cc recipients gathered from reply-box @mentions. The chip list is the source
  // of truth for who gets added; the inline `@Name` text is cosmetic.
  const [replyCc, setReplyCc] = useState<string[]>([]);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Reply-to address, used inside onPick to avoid Cc-ing the person already on
  // the To line. Recomputed each render, so the inline onPick always closes over
  // the current value (no ref needed).
  const replyToAddr = selectedEmail ? emailAddress(selectedEmail.sender) : "";
  const mention = useMentionSearch({
    value: replyBody,
    setValue: setReplyBody,
    textareaRef: replyTextareaRef,
    onPick: (c) => {
      const email = c.address.trim();
      const replyToLower = (replyToAddr ?? "").toLowerCase();
      setReplyCc((prev) =>
        !email ||
        prev.some((e) => e.toLowerCase() === email.toLowerCase()) ||
        email.toLowerCase() === replyToLower
          ? prev
          : [...prev, email]
      );
    },
  });
  const [forwardAttachments, setForwardAttachments] = useState<File[]>([]);
  const forwardFileRef = useRef<HTMLInputElement>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // Recovery when the body fetch failed on a dead Gmail refresh token. Hands off
  // to the same per-account OAuth flow the Integrations page uses; Google
  // redirects back and the body loads with a fresh token.
  const handleReconnectGmail = async () => {
    setReconnecting(true);
    setReconnectError(null);
    try {
      window.location.href = await getGmailConnectUrl();
    } catch (err) {
      setReconnectError(
        err instanceof Error ? err.message : "Could not start reconnect."
      );
      setReconnecting(false);
    }
  };

  // Local mirror of the shared-inbox workflow state, so the UI updates without
  // refetching the whole list. The backend's PATCH response replaces it.
  const [inboxState, setInboxState] = useState<InboxState | null>(null);
  const [stateSaving, setStateSaving] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedEmail?.is_shared && selectedEmail.id) {
        setInboxState({
          email_id: selectedEmail.id,
          status: (selectedEmail.inbox_status ??
            "open") as InboxState["status"],
          assignee_id: selectedEmail.inbox_assignee_id ?? null,
          updated_at: null,
          updated_by: null,
        });
        setStateError(null);
      } else {
        setInboxState(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    selectedEmail?.id,
    selectedEmail?.is_shared,
    selectedEmail?.inbox_status,
    selectedEmail?.inbox_assignee_id,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setReplyOpen(false);
      setReplyBody("");
      setReplyError(null);
      setForwardOpen(false);
      setForwardTo("");
      setForwardBody("");
      setForwardError(null);
      // Otherwise the menu lingers over the next message, showing the previous
      // sender's address.
      setSenderMenuOpen(false);
      setSenderCopied(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedEmail?.id]);

  // Move focus to the reading pane when an email opens, so the very first wheel
  // or arrow-key scroll acts on this scroll container rather than the list row
  // that was just clicked. `preventScroll` keeps the pane pinned at the top.
  useEffect(() => {
    if (viewMode !== "email" || !selectedEmail) return;
    const el = detailRef.current;
    if (!el) return;
    const timer = window.setTimeout(() => el.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [selectedEmail?.id, viewMode]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (
        moreRef.current &&
        event.target instanceof Node &&
        !moreRef.current.contains(event.target)
      ) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // Same dismissal contract as the kebab above.
  useEffect(() => {
    if (!senderMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (
        senderMenuRef.current &&
        event.target instanceof Node &&
        !senderMenuRef.current.contains(event.target)
      ) {
        setSenderMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSenderMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [senderMenuOpen]);

  const copySenderAddress = (address: string) => {
    void navigator.clipboard?.writeText(address).then(() => {
      setSenderCopied(true);
      window.setTimeout(() => setSenderCopied(false), 1500);
    });
  };

  const filterBySender = (address: string) => {
    onFilterBySender?.(address);
    setSenderMenuOpen(false);
  };

  async function patchInboxState(
    patch: Parameters<typeof updateEmailState>[1]
  ) {
    if (!selectedEmail) return;
    setStateSaving(true);
    setStateError(null);
    try {
      const next = await updateEmailState(selectedEmail.id, patch);
      setInboxState(next);
    } catch (err) {
      setStateError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setStateSaving(false);
    }
  }

  // The three entry points below sit above the "no email selected" early return
  // because the shortcut hook has to run unconditionally, and it needs them.

  const handleDelete = async () => {
    // The button carries disabled={deleting}; the keyboard path needs its own
    // guard so a second `D` can't fire a concurrent delete.
    if (!selectedEmail || deleting) return;
    const ok = window.confirm(
      "Delete this email permanently from Fluxze and your mail provider?"
    );
    if (!ok) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteEmail(selectedEmail.id);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete email"
      );
    } finally {
      setDeleting(false);
    }
  };

  // These take an explicit target state rather than toggling, so the shortcuts
  // can force-open (pressing R twice must not close the composer) while the
  // header buttons keep their toggle behaviour by passing the negated state.
  const showReply = (next: boolean) => {
    setReplyOpen(next);
    setReplyError(null);
    setForwardOpen(false);
    setForwardError(null);
  };

  const showForward = (next: boolean) => {
    if (!selectedEmail) return;
    setReplyOpen(false);
    setReplyError(null);
    setForwardOpen(next);
    if (next && !forwardBody.trim()) {
      setForwardBody(buildForwardBody(selectedEmail));
    }
    setForwardError(null);
  };

  // Shared by the Cancel buttons and Escape so the two can't drift. Neither
  // clears the draft body — reopening the composer gets your text back, which
  // matters far more for a stray Escape than for a deliberate Cancel click.
  // Focus returns to the pane so the next shortcut still lands.
  const cancelReply = () => {
    setReplyOpen(false);
    setReplyError(null);
    setReplyCc([]);
    detailRef.current?.focus({ preventScroll: true });
  };

  const cancelForward = () => {
    setForwardOpen(false);
    setForwardError(null);
    detailRef.current?.focus({ preventScroll: true });
  };

  // Gmail-style shortcuts for the open message: fixed bindings, no remapping.
  // useShortcuts already drops bare keys while a text field has focus, so typing
  // "reply" into the composer is safe; overlayOpen() covers the popups on top.
  useShortcuts(
    {
      r: () => {
        if (overlayOpen()) return;
        showReply(true);
      },
      f: () => {
        if (overlayOpen()) return;
        showForward(true);
      },
      d: () => {
        if (overlayOpen()) return;
        void handleDelete();
      },
      // Escape is exempt from the hook's typing guard (ALWAYS_ACTIVE), which is
      // the whole point here: after R the caret is in the reply box, so a bare
      // key that respected focus could never reach this. It cancels the
      // composer and nothing else — deliberately not a way out of the message,
      // since that was the behaviour rejected when these shortcuts landed.
      escape: () => {
        // A popup owns Escape while open. The @mention list is a role="listbox"
        // and handles its own Escape, so this covers it twice over — the hook
        // also skips anything already defaultPrevented.
        if (overlayOpen()) return;
        if (replyOpen) {
          cancelReply();
          return;
        }
        if (forwardOpen) cancelForward();
      },
    },
    // The hook runs before the early return below, so !!selectedEmail is what
    // keeps `D` from firing over the "Select an email" placeholder.
    viewMode === "email" && !!selectedEmail
  );

  // The attachments view is no longer rendered here: it is a list pane plus a
  // detail pane of its own (EmailFilesPane), mounted by Emails.tsx alongside
  // the email list rather than inside the message pane.

  if (!selectedEmail) {
    return (
      <div className="email-detail">
        <p>Select an email</p>
      </div>
    );
  }

  const handleMarkNoise = async () => {
    if (!onMarkNoise) return;
    try {
      await onMarkNoise(selectedEmail.id);
      // The sender's mail (this email included) is now Noise, so leave the
      // detail and return to the list where it's been filtered out.
      onBack();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to mark sender as noise"
      );
    }
  };

  const replyTo = emailAddress(selectedEmail.sender);
  const originalSubject = displaySubject(selectedEmail);
  const forwardSubject = originalSubject.toLowerCase().startsWith("fwd:")
    ? originalSubject
    : `Fwd: ${originalSubject}`;

  const handleReply = async () => {
    const body = replyBody.trim();

    if (!selectedEmail.account_id) {
      setReplyError("Missing sender account for this email.");
      return;
    }

    if (!replyTo) {
      setReplyError("Missing recipient for reply.");
      return;
    }

    if (!body) {
      setReplyError("Enter a reply before sending.");
      return;
    }

    setReplySending(true);
    setReplyError(null);
    try {
      const subject = selectedEmail.subject?.trim() || "(No Subject)";
      const attachments =
        replyAttachments.length > 0
          ? await filesToAttachments(replyAttachments)
          : undefined;
      await sendEmail({
        account_id: selectedEmail.account_id,
        to: replyTo,
        cc: replyCc.length > 0 ? replyCc : undefined,
        subject: subject.toLowerCase().startsWith("re:")
          ? subject
          : `Re: ${subject}`,
        body,
        attachments,
      });
      setReplyBody("");
      setReplyAttachments([]);
      setReplyCc([]);
      setReplyOpen(false);
    } catch (err) {
      setReplyError(
        err instanceof Error ? err.message : "Failed to send reply"
      );
    } finally {
      setReplySending(false);
    }
  };

  const handleForward = async () => {
    const to = forwardTo.trim();
    const body = forwardBody.trim();

    if (!selectedEmail.account_id) {
      setForwardError("Missing sender account for this email.");
      return;
    }

    if (!to) {
      setForwardError("Enter a recipient for the forwarded email.");
      return;
    }

    if (!body) {
      setForwardError("Forward message is empty.");
      return;
    }

    setForwardSending(true);
    setForwardError(null);
    try {
      const attachments =
        forwardAttachments.length > 0
          ? await filesToAttachments(forwardAttachments)
          : undefined;
      await sendEmail({
        account_id: selectedEmail.account_id,
        to,
        subject: forwardSubject,
        body,
        attachments,
      });
      setForwardTo("");
      setForwardBody("");
      setForwardAttachments([]);
      setForwardOpen(false);
    } catch (err) {
      setForwardError(
        err instanceof Error ? err.message : "Failed to forward email"
      );
    } finally {
      setForwardSending(false);
    }
  };

  // Shared by the reply and forward composers. The 20 MB total cap matches the
  // backend's limit.
  const renderAttachField = (
    files: File[],
    setFiles: React.Dispatch<React.SetStateAction<File[]>>,
    setErr: (message: string | null) => void,
    inputRef: React.RefObject<HTMLInputElement>
  ) => (
    <div className="email-compose-attach">
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length === 0) return;
          const next = [...files, ...picked];
          if (next.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENTS_BYTES) {
            setErr("Attachments exceed the 20 MB limit");
            return;
          }
          setFiles(next);
        }}
      />
      <button
        type="button"
        className="email-compose-attach-btn"
        onClick={() => inputRef.current?.click()}
      >
        📎 Attach
      </button>
      {files.length > 0 && (
        <div className="email-compose-attachments">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="email-compose-attachment"
            >
              📎 {file.name} · {formatFileSize(file.size)}
              <button
                type="button"
                className="email-compose-attachment-remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="email-detail" ref={detailRef} tabIndex={-1}>
      <div className="email-detail-header">
        <button
          type="button"
          className="email-detail-back-top"
          onClick={onBack}
          data-tooltip="Back to list"
          aria-label="Back to list"
        >
          <svg
            className="email-detail-back-top-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          <span>Back</span>
        </button>
        <div className="email-detail-actions">
          <button
            className="email-detail-reply"
            onClick={() => showReply(!replyOpen)}
            data-tooltip="Reply (R)"
            aria-label="Reply"
          >
            <svg
              className="email-detail-reply-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M10 8 5 13l5 5" />
              <path d="M5 13h9a5 5 0 0 1 5 5v1" />
            </svg>
            <span>Reply</span>
          </button>
          <button
            className="email-detail-forward"
            onClick={() => showForward(!forwardOpen)}
            data-tooltip="Forward (F)"
            aria-label="Forward"
          >
            <svg
              className="email-detail-forward-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M14 8l5 5-5 5" />
              <path d="M5 19v-1a5 5 0 0 1 5-5h9" />
            </svg>
            <span>Forward</span>
          </button>
          <button
            className="email-detail-delete"
            onClick={() => void handleDelete()}
            disabled={deleting}
            data-tooltip="Delete email (D)"
            data-tooltip-align="right"
            aria-label="Delete email"
          >
            {deleting ? (
              "…"
            ) : (
              <svg
                className="email-detail-delete-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M4 7h16" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M6 7l1 14h10l1-14" />
                <path d="M9 7V4h6v3" />
              </svg>
            )}
          </button>
          <button
            className="email-detail-back"
            onClick={onBack}
            data-tooltip="Close"
            aria-label="Close"
          >
            ✕
          </button>
          <div className="email-detail-more" ref={moreRef}>
            <button
              type="button"
              className="email-detail-more-btn"
              onClick={() => setMoreOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              data-tooltip="More"
              aria-label="More actions"
            >
              ⋮
            </button>
            {moreOpen && (
              <div className="email-detail-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="email-detail-more-item"
                  onClick={() => {
                    setMoreOpen(false);
                    void handleMarkNoise();
                  }}
                >
                  Mark as Noise
                </button>
                {["test2", "test3"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="menuitem"
                    className="email-detail-more-item"
                    onClick={() => setMoreOpen(false)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <h2 className="email-detail-subject">
        {selectedEmail.subject || "(No subject)"}
      </h2>
      {deleteError && <p className="email-body-error">{deleteError}</p>}

      {(() => {
        const { name: senderName, email: senderEmail } = splitSender(
          selectedEmail.sender
        );
        const initial =
          (senderName || senderEmail || "?").trim().charAt(0).toUpperCase() ||
          "?";
        return (
          <div className="email-meta-row">
            <div
              className="email-meta-avatar"
              aria-hidden="true"
              style={{ background: avatarColor(senderName || senderEmail) }}
            >
              {initial}
            </div>
            <div className="email-meta-info">
              <div className="email-meta-from" ref={senderMenuRef}>
                {/* The whole from-line is the trigger, not just the address:
                    splitSender puts a name-less sender in `senderName`, so an
                    address-only target would miss those messages entirely. */}
                <button
                  type="button"
                  className="email-meta-sender"
                  onClick={() => setSenderMenuOpen((open) => !open)}
                  disabled={!senderEmail}
                  aria-haspopup="menu"
                  aria-expanded={senderMenuOpen}
                  data-tooltip={senderEmail ? "Copy or filter by sender" : ""}
                >
                  <span className="email-meta-name">
                    {senderName || senderEmail || "Unknown sender"}
                  </span>
                  {senderName && senderEmail && (
                    <span className="email-meta-email">
                      &lt;{senderEmail}&gt;
                    </span>
                  )}
                </button>
                {senderMenuOpen && senderEmail && (
                  // role="menu" is load-bearing: overlayOpen() keys off it to
                  // stand the R/F/D shortcuts down while this is open.
                  <div className="email-sender-menu" role="menu">
                    <div className="email-sender-menu-head">
                      <span className="email-sender-menu-address">
                        {senderEmail}
                      </span>
                      <button
                        type="button"
                        role="menuitem"
                        className="email-sender-menu-copy"
                        onClick={() => copySenderAddress(senderEmail)}
                        data-tooltip={senderCopied ? "Copied!" : "Copy address"}
                        aria-label={
                          senderCopied ? "Address copied" : "Copy address"
                        }
                      >
                        {senderCopied ? "✓" : "⧉"}
                      </button>
                    </div>
                    {onFilterBySender && (
                      <button
                        type="button"
                        role="menuitem"
                        className="email-sender-menu-item"
                        onClick={() => filterBySender(senderEmail)}
                      >
                        Messages from this sender
                      </button>
                    )}
                  </div>
                )}
              </div>
              {selectedEmail.receiver && (
                <div className="email-meta-to">to {selectedEmail.receiver}</div>
              )}
            </div>
            <div className="email-meta-time">
              {formatEmailDateTime(selectedEmail.created_at)}
            </div>
          </div>
        );
      })()}

      {/* Shared-inbox workflow controls. Invisible for personal mail. */}
      {selectedEmail.is_shared && inboxState && (
        <div
          className="inbox-workflow-bar"
          role="group"
          aria-label="Shared inbox workflow"
        >
          <label className="inbox-workflow-field">
            <span>Status</span>
            <select
              value={inboxState.status}
              disabled={stateSaving}
              onChange={(e) => {
                const next = e.target.value as InboxState["status"];
                void patchInboxState({ status: next });
              }}
            >
              <option value="open">Open</option>
              <option value="pending">Pending</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <div className="inbox-workflow-field">
            <span>Assignee</span>
            <div className="inbox-workflow-assignee">
              {inboxState.assignee_id ? (
                <>
                  <span className="inbox-workflow-pill">
                    User #{inboxState.assignee_id}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void patchInboxState({ clear_assignee: true })
                    }
                    disabled={stateSaving}
                    className="inbox-workflow-unassign"
                  >
                    Unassign
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (user?.id)
                      void patchInboxState({ assignee_id: user.id });
                  }}
                  disabled={stateSaving || !user?.id}
                  className="inbox-workflow-assign"
                >
                  Assign to me
                </button>
              )}
            </div>
          </div>
          {stateError && (
            <span className="inbox-workflow-error">{stateError}</span>
          )}
        </div>
      )}

      {replyOpen && (
        <div className="email-reply-box">
          <div className="email-reply-input">
            {mention.open && (
              <ul className="email-mention-menu" role="listbox">
                {mention.results.map((candidate, i) => (
                  <li key={candidate.address} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === mention.highlighted}
                      className={`email-mention-item${
                        i === mention.highlighted ? " active" : ""
                      }`}
                      // onMouseDown (not onClick) so the textarea keeps focus and
                      // the caret splice lands correctly.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        mention.apply(candidate);
                      }}
                      onMouseEnter={() => mention.setIndex(i)}
                    >
                      <ContactAvatar
                        photoUrl={candidate.photo_url}
                        label={mentionLabel(candidate)}
                      />
                      <span className="email-mention-label">
                        {mentionLabel(candidate)}
                      </span>
                      <span className="email-mention-email">
                        {candidate.address}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={replyTextareaRef}
              value={replyBody}
              onChange={(e) => {
                setReplyBody(e.target.value);
                mention.syncFromCaret(e.target);
              }}
              onClick={(e) => mention.syncFromCaret(e.currentTarget)}
              onKeyUp={(e) => {
                if (
                  e.key.startsWith("Arrow") ||
                  e.key === "Home" ||
                  e.key === "End"
                ) {
                  mention.syncFromCaret(e.currentTarget);
                }
              }}
              onKeyDown={(e) => mention.onKeyDown(e)}
              placeholder={`Reply to ${replyTo || "sender"} — @ to mention`}
              aria-label="Reply body"
              // Fires on the commit that mounts the textarea, i.e. exactly the
              // closed -> open transition, so `R` lands the caret here. An
              // effect on replyOpen would instead race the pane-focus timeout
              // when switching emails and leave focus on <body>.
              autoFocus
            />
          </div>
          {replyCc.length > 0 && (
            <div className="email-reply-cc" aria-label="Cc recipients">
              <span className="email-reply-cc-label">Cc:</span>
              {replyCc.map((email) => (
                <span className="email-reply-cc-chip" key={email}>
                  {email}
                  <button
                    type="button"
                    className="email-reply-cc-remove"
                    aria-label={`Remove ${email} from Cc`}
                    onClick={() =>
                      setReplyCc((cc) => cc.filter((e) => e !== email))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {replyError && <p className="email-body-error">{replyError}</p>}
          {renderAttachField(
            replyAttachments,
            setReplyAttachments,
            setReplyError,
            replyFileRef
          )}
          <div className="email-reply-actions">
            <button
              type="button"
              className="email-reply-send"
              onClick={() => void handleReply()}
              disabled={replySending}
            >
              {replySending ? "Sending..." : "Send"}
            </button>
            <button
              type="button"
              className="email-reply-cancel"
              onClick={cancelReply}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {forwardOpen && (
        <div className="email-reply-box email-forward-box">
          <input
            className="email-forward-to"
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
            placeholder="Forward to"
            aria-label="Forward recipient"
          />
          <div className="email-forward-subject">{forwardSubject}</div>
          <textarea
            value={forwardBody}
            onChange={(e) => setForwardBody(e.target.value)}
            placeholder="Forward message"
            aria-label="Forward body"
          />
          {forwardError && <p className="email-body-error">{forwardError}</p>}
          {renderAttachField(
            forwardAttachments,
            setForwardAttachments,
            setForwardError,
            forwardFileRef
          )}
          <div className="email-reply-actions">
            <button
              type="button"
              className="email-reply-send"
              onClick={() => void handleForward()}
              disabled={forwardSending}
            >
              {forwardSending ? "Forwarding..." : "Send forward"}
            </button>
            <button
              type="button"
              className="email-reply-cancel"
              onClick={cancelForward}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="email-body">
        {selectedEmail._bodyLoading ? (
          <div className="email-body-loading">
            <span className="spinner" aria-hidden="true" />
            <span>Loading email …</span>
          </div>
        ) : selectedEmail._bodyError ? (
          <div className="email-body-error">
            <p>
              {typeof selectedEmail._bodyError === "string"
                ? selectedEmail._bodyError
                : "Failed to load email body. Try again."}
            </p>
            {isGmailReconnectError(selectedEmail._bodyError) && (
              <div className="email-body-reconnect">
                <button
                  type="button"
                  className="email-reconnect-btn"
                  onClick={() => void handleReconnectGmail()}
                  disabled={reconnecting}
                >
                  {reconnecting ? "Redirecting…" : "Reconnect Gmail"}
                </button>
                {reconnectError && (
                  <span className="email-reconnect-error">
                    {reconnectError}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <EmailBody body={selectedEmail.body || ""} />
        )}
      </div>

      {(selectedEmail.attachments?.length ?? 0) > 0 && (
        <div className="email-attachments">
          <div className="email-attachments-title">Attachments</div>
          {selectedEmail.attachments?.map((attachment) => (
            <button
              key={attachment.id}
              className="email-attachment"
              onClick={() =>
                downloadEmailAttachment(attachment, user?.id ?? null)
              }
            >
              <span className="email-attachment-icon">📎</span>
              <span className="email-attachment-name">
                {attachment.filename}
              </span>
              <span className="email-attachment-size">
                {formatFileSize(attachment.size)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function emailAddress(value?: string | null) {
  const text = value?.trim() || "";
  const match = text.match(/<([^>]+)>/);
  return (match?.[1] || text).trim();
}

function displaySubject(email: EmailItem): string {
  return email.subject?.trim() || "(No Subject)";
}

// The quoted header + body a forward is pre-filled with. Module-level so the
// component can expose a single `showForward` entry point above its early
// return, which both the Forward button and the `F` shortcut call.
function buildForwardBody(email: EmailItem): string {
  return [
    "",
    "",
    "---------- Forwarded message ---------",
    `From: ${email.sender || "Unknown sender"}`,
    email.receiver ? `To: ${email.receiver}` : null,
    `Date: ${formatEmailDate(email.created_at) || "Unknown date"}`,
    `Subject: ${displaySubject(email)}`,
    "",
    bodyToPlainText(email.body || ""),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

// A popup owns the keyboard while it is open, so the reading pane behind it
// stands down — otherwise typing in the compose modal, or arrowing through the
// list's select menu, would fire actions on the message underneath. Matched by
// role rather than by refs because the overlays live in sibling trees (the
// compose Modal, EmailList's select menu, this pane's kebab, the @mention list,
// ProviderPicker, ThemeToggle, SplitMenu). A false positive costs one inert
// keypress, never a wrong action.
const OVERLAY_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"]';

function overlayOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

function bodyToPlainText(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (!/<[a-z][\s\S]*>/i.test(text)) return text;

  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    return (doc.body.textContent || text).trim();
  } catch {
    return text
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

// Parse "Display Name <addr@example.com>" into separate parts. If only an
// email address is provided (no angle brackets), name is empty.
function splitSender(value?: string | null): { name: string; email: string } {
  const raw = value?.trim() || "";
  const match = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ""),
      email: match[2].trim(),
    };
  }
  return { name: "", email: raw };
}

// Gmail-style: time only for today, month and day within this year, otherwise
// the full date.
function formatEmailDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("en-US", {
      timeZone: APP_TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("en-US", {
      timeZone: APP_TIME_ZONE,
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The reading view always shows the complete received date and time, unlike the
// compact `formatEmailDate` used in the list.
function formatEmailDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
