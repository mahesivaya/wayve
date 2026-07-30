import { logger } from "../utils/logger";
import {
  getUserByEmail,
  searchContacts,
  sendEmail as sendEmailApi,
  sendInternalEmail,
  sendSecureEmail,
  filesToAttachments,
  MAX_ATTACHMENTS_BYTES,
  type ContactSuggestion,
  type WayveRecipient,
} from "../api/email";
import { useAuth } from "../auth/useAuth";
import { loadPublicKey } from "../crypto/keyStore";
import {
  buildInternalEnvelope,
  type InternalRecipientKey,
} from "./internalEnvelope";
import { sealSecureMessage } from "./secureSend";
import { formatFileSize } from "./renderUtils";

import { useState, useEffect, useRef, type ChangeEvent } from "react";

type SendEmailProps = {
  accountId: number;
  onClose?: () => void;
  onSent?: () => void;
};

// Accepts commas, semicolons, or whitespace as separators. Empty strings are
// filtered out so a trailing separator doesn't produce a ghost address.
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const RECIPIENT_SEP = /[,;\s]/;

// The recipient "token" under the caret — the maximal run of non-separator
// characters containing the caret. Powers the To-field contacts typeahead so a
// pick replaces just the address being typed, not the whole field.
function currentRecipientToken(
  value: string,
  caret: number
): { token: string; start: number; end: number } {
  let start = caret;
  while (start > 0 && !RECIPIENT_SEP.test(value[start - 1])) start--;
  let end = caret;
  while (end < value.length && !RECIPIENT_SEP.test(value[end])) end++;
  return { token: value.slice(start, end), start, end };
}

export default function SendEmail({
  accountId,
  onClose,
  onSent,
}: SendEmailProps) {
  const { user } = useAuth();
  const [to, setTo] = useState("");
  // Compose "To" contacts typeahead. `contactQuery` is the token under the caret
  // (null when inactive); `contactRange` is where a pick splices the address in.
  const toInputRef = useRef<HTMLInputElement>(null);
  const [contactQuery, setContactQuery] = useState<string | null>(null);
  const [contactRange, setContactRange] = useState<{ start: number; end: number }>(
    { start: 0, end: 0 }
  );
  const [contactSuggestions, setContactSuggestions] = useState<
    ContactSuggestion[]
  >([]);
  const [contactIndex, setContactIndex] = useState(0);
  const contactReqId = useRef(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // When on, every recipient (Wayve or external) gets the magic-link path with
  // the same user-supplied passphrase, overriding the encryption mode below.
  const [secureSend, setSecureSend] = useState(false);
  const [passphrase, setPassphrase] = useState("");

  // "standard" (default) sends plain SMTP to the recipient's real mailbox: it
  // reaches external accounts but is not E2E. "e2e" encrypts in-browser and is
  // only readable inside Fluxze accounts; recipients who aren't Fluxze users
  // have no key, so they fall back to SMTP. "pgp" is a disabled placeholder.
  type EncryptionMode = "standard" | "e2e" | "pgp";
  const [encryptionMode, setEncryptionMode] =
    useState<EncryptionMode>("standard");

  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Attachments are standard-mailbox only. Picking files forces the send down
  // the SMTP path (see `forceStandard` below) regardless of the E2E choice.
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const totalAttachmentBytes = attachments.reduce((n, f) => n + f.size, 0);

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be re-picked after removal
    if (picked.length === 0) return;
    const next = [...attachments, ...picked];
    if (next.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENTS_BYTES) {
      setStatus("Attachments exceed the 20 MB limit ⚠️");
      return;
    }
    setAttachments(next);
  };

  const removeAttachment = (index: number) =>
    setAttachments((cur) => cur.filter((_, i) => i !== index));

  // Debounced contacts search whenever the active To-field token changes. Never
  // sets state synchronously in the effect body (a short token schedules no
  // fetch); `contactOpen` below hides any now-stale suggestions.
  useEffect(() => {
    if (contactQuery === null || contactQuery.trim().length < 2) return;
    const mine = ++contactReqId.current;
    const handle = setTimeout(() => {
      void searchContacts(contactQuery)
        .then((rows) => {
          if (mine === contactReqId.current) {
            setContactSuggestions(rows.slice(0, 6));
            setContactIndex(0);
          }
        })
        .catch(() => {
          if (mine === contactReqId.current) setContactSuggestions([]);
        });
    }, 180);
    return () => clearTimeout(handle);
  }, [contactQuery]);

  const contactOpen =
    contactQuery !== null &&
    contactQuery.trim().length >= 2 &&
    contactSuggestions.length > 0;
  const contactHighlighted = Math.min(
    contactIndex,
    contactSuggestions.length - 1
  );

  // Reads the token under the caret and arms/dismisses the typeahead.
  const syncContactToken = (el: HTMLInputElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const { token, start, end } = currentRecipientToken(el.value, caret);
    if (token.length >= 2) {
      setContactQuery(token);
      setContactRange({ start, end });
    } else {
      setContactQuery(null);
    }
  };

  // Replaces the active token with the chosen address, followed by ", ".
  const applyContact = (address: string) => {
    const before = to.slice(0, contactRange.start);
    const after = to.slice(contactRange.end);
    const insert = `${address}, `;
    const next = before + insert + after;
    setTo(next);
    setContactQuery(null);
    setContactSuggestions([]);
    const caret = (before + insert).length;
    const el = toInputRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  };

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const sendEmail = async () => {
    const recipients = parseRecipients(to);
    if (recipients.length === 0 || !subject || !body) {
      setStatus("Please fill all fields ⚠️");
      return;
    }
    if (secureSend && passphrase.length < 6) {
      setStatus("Passphrase must be at least 6 characters ⚠️");
      return;
    }
    // Secure send can't carry attachments. Block the mismatch rather than
    // silently dropping files or weakening the encryption.
    if (secureSend && attachments.length > 0) {
      setStatus(
        "Secure send can't include attachments — remove them or turn off Secure send ⚠️"
      );
      return;
    }

    setLoading(true);
    setStatus("");

    try {
      // Secure send treats Wayve and non-Wayve recipients identically and never
      // auto-promotes Wayve users to the native channel. The sealed bundle is
      // the same for everyone, so seal once (WebCrypto sealing is expensive),
      // but upload it per recipient so each gets its own revocable token.
      if (secureSend) {
        const bundle = await sealSecureMessage(body, passphrase);
        const secureErrors: string[] = [];
        const results = await Promise.allSettled(
          recipients.map((recipient) =>
            sendSecureEmail({ recipient_email: recipient, subject, ...bundle })
          )
        );
        results.forEach((res, i) => {
          if (res.status === "rejected") {
            const recipient = recipients[i];
            logger.error("secure-send failed", res.reason, recipient);
            secureErrors.push(
              res.reason instanceof Error
                ? `${recipient}: ${res.reason.message}`
                : `${recipient}: secure-send failed`
            );
          }
        });
        const secureDelivered = recipients.length - secureErrors.length;
        if (secureDelivered > 0) {
          setStatus(
            `Secure link sent to ${secureDelivered} recipient${secureDelivered === 1 ? "" : "s"} — share the passphrase out-of-band ✅`
          );
        }
        if (secureErrors.length > 0) {
          setStatus(`${status} ⚠️ ${secureErrors.join("; ")}`);
        }
        if (secureErrors.length === 0) {
          setTo("");
          setSubject("");
          setBody("");
          setPassphrase("");
          setSecureSend(false);
          onSent?.();
          setTimeout(() => onClose?.(), 800);
        }
        return;
      }

      const senderId = user?.id;

      const attachmentPayloads =
        attachments.length > 0
          ? await filesToAttachments(attachments)
          : undefined;
      // Attachments are standard-mailbox only, so any file forces every
      // recipient down the SMTP path and skips the E2E internal channel.
      const forceStandard = attachments.length > 0;

      // Only "e2e" needs to detect Fluxze users; standard mode skips the
      // lookups entirely. A lookup failure is treated as "not on Wayve", so a
      // transient API hiccup degrades to SMTP rather than failing the send.
      const lookups: Array<{ email: string; user: WayveRecipient | null }> =
        encryptionMode === "standard" || forceStandard
          ? recipients.map((email) => ({ email, user: null }))
          : await Promise.all(
              recipients.map(async (email) => {
                try {
                  return { email, user: await getUserByEmail(email) };
                } catch (err) {
                  logger.warn(
                    "Wayve recipient lookup failed; treating as external",
                    err,
                    email
                  );
                  return { email, user: null };
                }
              })
            );

      // Only a Wayve user with a non-empty public key can take the native
      // channel. An unknown address, or a Wayve user with no key on file,
      // falls back to SMTP.
      const wayveLookups: Array<{ email: string; user: WayveRecipient }> = [];
      const externalEmails: string[] = [];
      for (const l of lookups) {
        if (
          l.user !== null &&
          Array.isArray(l.user.public_key) &&
          l.user.public_key.length > 0
        ) {
          wayveLookups.push({ email: l.email, user: l.user });
        } else {
          externalEmails.push(l.email);
        }
      }

      let internalDelivered = 0;
      let externalDelivered = 0;
      const errors: string[] = [];

      // Wayve-to-Wayve native channel. One envelope wraps every Wayve recipient
      // plus the sender's own slot, so their Sent copy stays decryptable.
      if (wayveLookups.length > 0 && senderId !== undefined) {
        // Enterprise-tier senders get server-readable encryption instead: the
        // backend accepts a plaintext body in place of a WAYVE_SECURE_V1
        // envelope and applies only its own at-rest layer.
        const standardEncryption = user?.current_plan?.tier === "enterprise";

        try {
          let envelope: string;
          if (standardEncryption) {
            envelope = body;
          } else {
            const recipientsForEnvelope: InternalRecipientKey[] =
              wayveLookups.map(({ user: u }) => ({
                userId: u.id,
                publicKeyBytes: u.public_key as number[],
              }));

            const senderPubKeyRaw = await loadPublicKey(
              senderId,
              user?.email
            ).catch(() => null);
            if (senderPubKeyRaw) {
              recipientsForEnvelope.push({
                userId: senderId,
                publicKeyBytes: Array.from(new Uint8Array(senderPubKeyRaw)),
              });
            } else {
              logger.warn(
                "no sender public key on this device; Sent copy will be unreadable"
              );
            }

            envelope = await buildInternalEnvelope(body, recipientsForEnvelope);
          }

          const res = await sendInternalEmail({
            recipient_user_ids: wayveLookups.map((l) => l.user.id),
            envelope,
            subject,
          });
          internalDelivered = res.delivered;
        } catch (err) {
          logger.error("Wayve internal send failed", err);
          errors.push(
            err instanceof Error
              ? `Wayve recipients: ${err.message}`
              : "Wayve send failed"
          );
        }
      } else if (wayveLookups.length > 0 && senderId === undefined) {
        // Wayve users resolved but the SPA hasn't resolved the signed-in user
        // yet, so there is no sender key. Fall back to SMTP rather than stall.
        externalEmails.push(...wayveLookups.map((l) => l.email));
      }

      // The SMTP endpoint takes one `to` at a time, so loop sequentially and
      // let a per-recipient failure fall through without taking down the rest.
      for (const externalTo of externalEmails) {
        try {
          await sendEmailApi({
            account_id: accountId,
            to: externalTo,
            subject,
            body,
            attachments: attachmentPayloads,
          });
          externalDelivered += 1;
        } catch (err) {
          logger.error("External SMTP send failed", err, externalTo);
          errors.push(
            err instanceof Error
              ? `${externalTo}: ${err.message}`
              : `${externalTo}: send failed`
          );
        }
      }

      // Report per channel, so the user is never guessing whether a send
      // actually went E2E.
      if (internalDelivered > 0 && externalDelivered > 0) {
        setStatus(
          `Sent E2E to ${internalDelivered} Fluxze user${internalDelivered === 1 ? "" : "s"} + standard mail to ${externalDelivered} external recipient${externalDelivered === 1 ? "" : "s"} ✅`
        );
      } else if (internalDelivered > 0) {
        setStatus(
          `Sent end-to-end to ${internalDelivered} Fluxze user${internalDelivered === 1 ? "" : "s"} via Fluxze ✅`
        );
      } else if (externalDelivered > 0) {
        setStatus(
          `Email sent successfully to ${externalDelivered} recipient${externalDelivered === 1 ? "" : "s"} ✅`
        );
      }

      if (errors.length > 0) {
        // The form is cleared only on a fully clean send, so the user can retry
        // the failed recipients without retyping.
        setStatus(`${status} ⚠️ ${errors.join("; ")}`);
      }

      if (errors.length === 0) {
        setTo("");
        setSubject("");
        setBody("");
        setAttachments([]);
        onSent?.();
        setTimeout(() => onClose?.(), 800);
      }
    } catch (err) {
      logger.error(err);
      setStatus(err instanceof Error ? err.message : "Failed to send email ❌");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div style={{ position: "relative" }}>
        {contactOpen && (
          <ul className="email-mention-menu" role="listbox">
            {contactSuggestions.map((c, i) => (
              <li key={c.address} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === contactHighlighted}
                  className={`email-mention-item${
                    i === contactHighlighted ? " active" : ""
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyContact(c.address);
                  }}
                  onMouseEnter={() => setContactIndex(i)}
                >
                  {c.display_name && (
                    <span className="email-mention-label">
                      {c.display_name}
                    </span>
                  )}
                  <span className="email-mention-email">{c.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={toInputRef}
          placeholder="To — separate multiple addresses with commas"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            syncContactToken(e.target);
          }}
          onClick={(e) => syncContactToken(e.currentTarget)}
          onKeyUp={(e) => {
            if (
              e.key.startsWith("Arrow") ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              syncContactToken(e.currentTarget);
            }
          }}
          onKeyDown={(e) => {
            if (!contactOpen) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setContactIndex((n) => (n + 1) % contactSuggestions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setContactIndex(
                (n) =>
                  (n - 1 + contactSuggestions.length) %
                  contactSuggestions.length
              );
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              applyContact(contactSuggestions[contactHighlighted].address);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setContactQuery(null);
            }
          }}
          onBlur={() => setContactQuery(null)}
          style={{
            padding: "8px",
            borderRadius: 5,
            border: "1px solid #ccc",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
      </div>

      <input
        placeholder="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        style={{
          padding: "8px",
          borderRadius: 5,
          border: "1px solid #ccc",
        }}
      />

      <textarea
        placeholder="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        style={{
          padding: "8px",
          borderRadius: 5,
          border: "1px solid #ccc",
          minHeight: 120,
          resize: "none",
        }}
      />

      {/* Encryption (optional). No "Standard" radio — leaving both unselected
          IS standard delivery (a plain email to the recipient's real mailbox).
          Secure send (below) overrides routing, so dim this while it's on. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 10,
          border: "1px solid #d1d5db",
          borderRadius: 6,
          background: "#f9fafb",
          fontSize: 13,
          opacity: secureSend ? 0.5 : 1,
          pointerEvents: secureSend ? "none" : "auto",
        }}
      >
        <span style={{ fontWeight: 600, color: "#374151" }}>
          Advanced Encryption
        </span>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name="encryptionMode"
            checked={encryptionMode === "e2e"}
            // Clicking the selected radio toggles back to standard, since there
            // is no separate "Standard" radio to return to.
            onClick={() =>
              setEncryptionMode((m) => (m === "e2e" ? "standard" : "e2e"))
            }
            readOnly
            style={{ marginTop: 2 }}
          />
          <span>
            <strong>🛡️ End-to-End Encryption</strong>
            <br />
            <small style={{ color: "#6b7280" }}>
              Only visible to other Fluxze accounts.
            </small>
          </span>
        </label>

        {encryptionMode === "e2e" && (
          <small style={{ color: "#6b7280", lineHeight: 1.4 }}>
            Encrypted in your browser — delivered inside Fluxze. Recipients who
            aren’t on Fluxze get a standard email instead.
          </small>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 10,
          border: "1px solid #d1d5db",
          borderRadius: 6,
          background: "#f9fafb",
          fontSize: 13,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={secureSend}
            onChange={(e) => setSecureSend(e.target.checked)}
          />
          <span>🔒 Secure send (end-to-end via Fluxze magic link)</span>
        </label>
        {secureSend && (
          <>
            <input
              type="password"
              placeholder="Passphrase (share with recipient via Signal, SMS, or in person)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
              style={{
                padding: "8px",
                borderRadius: 5,
                border: "1px solid #ccc",
              }}
            />
            <small style={{ color: "#6b7280", lineHeight: 1.4 }}>
              The recipient gets a plain email with a link only. They click it
              and enter this passphrase to decrypt your message in their
              browser. <strong>Fluxze never sees the passphrase</strong> — if
              you share it in the same email, you defeat the encryption. Use
              Signal, SMS, or in-person.
            </small>
          </>
        )}
      </div>

      {/* Attachments (standard mailbox only — see `forceStandard`). */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={onPickFiles}
        style={{ display: "none" }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            alignSelf: "flex-start",
            background: "transparent",
            border: "1px solid var(--color-input-border, #ccc)",
            borderRadius: 5,
            padding: "6px 10px",
            cursor: "pointer",
            fontSize: 13,
            // Theme-aware so the label stays readable on the dark compose modal.
            color: "var(--color-text-primary, #111827)",
          }}
        >
          📎 Attach files
        </button>
        {attachments.length > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {attachments.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    background: "#f3f4f6",
                    borderRadius: 4,
                    padding: "4px 8px",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    📎 {file.name}
                  </span>
                  <span style={{ color: "#6b7280" }}>
                    {formatFileSize(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    aria-label={`Remove ${file.name}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "#6b7280",
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <small
              style={{
                color: "var(--color-text-muted, #6b7280)",
                lineHeight: 1.4,
              }}
            >
              Attachments are sent via your mailbox and aren’t end-to-end
              encrypted ({formatFileSize(totalAttachmentBytes)} of 20 MB).
            </small>
          </>
        )}
      </div>

      <button
        onClick={sendEmail}
        disabled={loading}
        style={{
          background: "#007bff",
          color: "white",
          padding: "10px",
          borderRadius: 5,
          border: "none",
          cursor: "pointer",
        }}
      >
        {loading ? "Sending..." : "Send"}
      </button>

      {status && (
        <div
          style={{
            fontSize: 12,
            color:
              status.includes("success") || status.includes("✅")
                ? "green"
                : "red",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
