import type { EmailItem } from "./types";

// Who a reply goes to. Normally the sender of the message being answered. But
// when that message is one of yours — common in a conversation, whose newest
// message is often your own reply — answering its sender would address the
// reply to yourself, so it goes to that message's recipients instead (Gmail
// does the same). Your own addresses are dropped either way; if nothing is
// left, it falls back to the sender.
export function replyRecipients(
  email: Pick<EmailItem, "sender" | "receiver">,
  ownAddresses: Iterable<string>
): string[] {
  const own = new Set(
    Array.from(ownAddresses, (a) => a.trim().toLowerCase()).filter(Boolean)
  );
  const sender = addressOf(email.sender ?? "");
  if (sender && !own.has(sender.toLowerCase())) return [sender];

  const seen = new Set<string>();
  const recipients = splitAddressList(email.receiver ?? "")
    .map(addressOf)
    .filter((a) => {
      const key = a.toLowerCase();
      if (!a || own.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (recipients.length > 0) return recipients;
  return sender ? [sender] : [];
}

// "Ada <ada@x.com>" → "ada@x.com"; a bare address is returned trimmed.
function addressOf(value: string): string {
  const text = value.trim();
  const match = text.match(/<([^>]+)>/);
  return (match?.[1] || text).trim();
}

// Splits an address header on commas, except inside a quoted display name
// ("Griffin, Peter" <peter@x.com>) or angle brackets.
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}
