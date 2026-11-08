import { addressOf, splitAddressList } from "./replyRecipients";

// The short recipient line under an open email's sender, as Gmail writes it:
// "me", "me, Ada", "Ada, Bob and 2 others". Your own addresses read as "me"
// and come first; anyone else is shown by first name, or the part of the
// address before the @ when the header has no name.
export function summarizeRecipients(
  receiver: string | null | undefined,
  cc: string | null | undefined,
  ownAddresses: Iterable<string>
): string {
  const own = new Set(
    Array.from(ownAddresses, (a) => a.trim().toLowerCase()).filter(Boolean)
  );
  const seen = new Set<string>();
  let includesMe = false;
  const others: string[] = [];
  for (const entry of [
    ...splitAddressList(receiver ?? ""),
    ...splitAddressList(cc ?? ""),
  ]) {
    const address = addressOf(entry);
    const key = address.toLowerCase();
    if (!address || seen.has(key)) continue;
    seen.add(key);
    if (own.has(key)) includesMe = true;
    else others.push(shortName(entry, address));
  }
  const names = includesMe ? ["me", ...others] : others;
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

// "Ada Lovelace <ada@x.com>" → "Ada"; "ada@x.com" → "ada".
function shortName(entry: string, address: string): string {
  const name = entry
    .replace(/<[^>]*>/, "")
    .trim()
    .replace(/^"|"$/g, "")
    .trim();
  if (name && name !== address) return name.split(/\s+/)[0];
  return address.split("@")[0] || address;
}

// Each address in a header on its own, for the expanded details card.
export function recipientList(value: string | null | undefined): string[] {
  return splitAddressList(value ?? "")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
