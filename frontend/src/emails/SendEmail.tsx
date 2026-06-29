import { logger } from "../utils/logger";
import {
  getUserByEmail,
  sendEmail as sendEmailApi,
  sendInternalEmail,
  sendSecureEmail,
  filesToAttachments,
  MAX_ATTACHMENTS_BYTES,
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

// Parse a free-form `To` value into individual email addresses. Accepts
// commas, semicolons, or whitespace as separators (the three things most
// users actually type — Gmail itself accepts the first two). Empty
// strings are filtered out so trailing separators don't produce ghost
// addresses.
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function SendEmail({
  accountId,
  onClose,
  onSent,
}: SendEmailProps) {
  const { user } = useAuth();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Plan A Phase 3 — Secure-send toggle. When on, EVERY recipient
  // (Wayve or external) gets the magic-link path with the same
  // user-supplied passphrase. Off (default) keeps the cascade in
  // place: Wayve users via internal channel, externals via plain SMTP.
  const [secureSend, setSecureSend] = useState(false);
  const [passphrase, setPassphrase] = useState("");

  // Encryption choice for the send (independent of Secure send):
  //   "standard" — DEFAULT. Plain email via SMTP to the recipient's real
  //                mailbox (Gmail/Outlook). Reaches external accounts; not E2E.
  //   "e2e"      — Wayve-to-Wayve internal channel: encrypted in-browser,
  //                only visible inside Fluxze accounts. Non-Fluxze recipients
  //                fall back to SMTP (can't E2E without their key).
  //   "pgp"      — placeholder, disabled in the UI for now.
  type EncryptionMode = "standard" | "e2e" | "pgp";
  const [encryptionMode, setEncryptionMode] =
    useState<EncryptionMode>("standard");

  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Standard-mailbox attachments (not E2E). Picking files forces the send down
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
    // Secure-send and E2E can't carry attachments in this scope — block the
    // mismatch rather than silently dropping files or weakening encryption.
    if (secureSend && attachments.length > 0) {
      setStatus(
        "Secure send can't include attachments — remove them or turn off Secure send ⚠️"
      );
      return;
    }

    setLoading(true);
    setStatus("");

    try {
      // ── Secure-send branch: every recipient gets the magic-link
      //    path with the same passphrase. The body is encrypted ONCE
      //    in the browser (the bundle is the same for everyone); we
      //    upload it once per recipient so each gets their own token
      //    (which lets the sender revoke or expire each one
      //    individually later if we add that UI). The recipient list
      //    can mix Wayve and non-Wayve addresses — Secure-send treats
      //    them identically and does not auto-promote Wayve users to
      //    the native channel.
      if (secureSend) {
        let secureDelivered = 0;
        const secureErrors: string[] = [];
        for (const recipient of recipients) {
          try {
            const bundle = await sealSecureMessage(body, passphrase);
            await sendSecureEmail({
              recipient_email: recipient,
              subject,
              ...bundle,
            });
            secureDelivered += 1;
          } catch (err) {
            logger.error("secure-send failed", err, recipient);
            secureErrors.push(
              err instanceof Error
                ? `${recipient}: ${err.message}`
                : `${recipient}: secure-send failed`
            );
          }
        }
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

      // Encode attachments once (base64) for the standard send payload.
      const attachmentPayloads =
        attachments.length > 0 ? await filesToAttachments(attachments) : undefined;
      // Attachments are standard-mailbox only: when files are attached, force
      // every recipient down the SMTP path (skip the E2E internal channel).
      const forceStandard = attachments.length > 0;

      // Standard (default) skips the Wayve-user lookups entirely — every
      // recipient gets a plain SMTP email to their real mailbox. Only the
      // "e2e" mode needs to detect Fluxze users to route them through the
      // encrypted internal channel. A lookup failure is treated as "not on
      // Wayve" so a transient API hiccup falls back to SMTP.
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

      // Partition the resolved lookups in one pass — anything that
      // resolves to a Wayve user WITH a non-empty public key goes
      // through the native channel; everything else (unknown address,
      // Wayve user without a pubkey on file) falls back to SMTP.
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

      // ── Wayve-to-Wayve native channel — ONE envelope covers all
      //    Wayve recipients at once (multi-recipient wrap), plus the
      //    sender's own slot so their Sent copy decrypts later.
      if (wayveLookups.length > 0 && senderId !== undefined) {
        // Enterprise-tier senders use standard (server-readable) encryption: the
        // backend accepts the plaintext body in place of a WAYVE_SECURE_V1 E2E
        // envelope and stores it server-readable. Everyone else builds the
        // multi-recipient E2E envelope (one wrap covering all recipients + the
        // sender's own Sent copy).
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
        // Edge case: lookups found Wayve users but the SPA hasn't
        // resolved the signed-in user yet. Fall the addresses back to
        // SMTP so the send doesn't get stuck.
        externalEmails.push(...wayveLookups.map((l) => l.email));
      }

      // ── Standard SMTP for non-Wayve recipients. The backend endpoint
      //    takes one `to` at a time; we loop sequentially so a per-
      //    recipient failure doesn't take down the rest.
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

      // ── Status summary — tell the user exactly what happened per
      //    channel so they're never guessing whether a send was E2E.
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
        // Any per-recipient failure surfaces but doesn't block the
        // overall flow if at least one delivery succeeded. Form is
        // cleared only on a fully clean send so the user can retry.
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
      <input
        placeholder="To — separate multiple addresses with commas"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        style={{
          padding: "8px",
          borderRadius: 5,
          border: "1px solid #ccc",
        }}
      />

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
            border: "1px solid #ccc",
            borderRadius: 5,
            padding: "6px 10px",
            cursor: "pointer",
            fontSize: 13,
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
            <small style={{ color: "#6b7280", lineHeight: 1.4 }}>
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
