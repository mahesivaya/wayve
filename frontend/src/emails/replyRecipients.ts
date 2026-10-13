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

// Everyone the message was addressed to, To and Cc, as bare addresses, once
// each. Cc is unknown (undefined) on mail synced before it was stored, and on
// a list row before the message is opened; only To counts then.
function recipientAddresses(
  email: Pick<EmailItem, "receiver" | "cc">
): string[] {
  const seen = new Set<string>();
  return [
    ...splitAddressList(email.receiver ?? ""),
    ...splitAddressList(email.cc ?? ""),
  ]
    .map(addressOf)
    .filter((a) => {
      const key = a.toLowerCase();
      if (!a.includes("@") || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Whether Reply all applies: the message went to more than one person.
export function hasMultipleRecipients(
  email: Pick<EmailItem, "receiver" | "cc">
): boolean {
  return recipientAddresses(email).length > 1;
}

// Who Reply all addresses, as Gmail does it: To is the sender plus the original
// To recipients, Cc the original Cc recipients. Your own addresses and
// duplicates are dropped; for a message you sent, the sender (you) is left
// out, so it goes back to the people you wrote to. If that leaves To empty,
// the Cc recipients move up into it, and failing that it falls back to Reply.
export function replyAllRecipients(
  email: Pick<EmailItem, "sender" | "receiver" | "cc">,
  ownAddresses: Iterable<string>
): { to: string[]; cc: string[] } {
  const own = new Set(
    Array.from(ownAddresses, (a) => a.trim().toLowerCase()).filter(Boolean)
  );
  const seen = new Set<string>();
  const keep = (address: string) => {
    const key = address.toLowerCase();
    if (!address.includes("@") || own.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const to = [
    addressOf(email.sender ?? ""),
    ...splitAddressList(email.receiver ?? "").map(addressOf),
  ].filter(keep);
  const cc = splitAddressList(email.cc ?? "")
    .map(addressOf)
    .filter(keep);
  if (to.length > 0) return { to, cc };
  if (cc.length > 0) return { to: cc, cc: [] };
  return { to: replyRecipients(email, own), cc: [] };
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
