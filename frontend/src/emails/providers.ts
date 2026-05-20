// Single source of truth for the mailbox-provider picker. Adding a new
// provider (Yahoo when it ships, Exchange, IMAP, iCloud, …) is a one-line
// change here plus a dispatch arm in [Emails.tsx](./Emails.tsx) —
// [EmailSidebar](./EmailSidebar.tsx) and [ProviderPicker](./ProviderPicker.tsx)
// read from this list and need no edits.

export type ProviderId = "gmail" | "outlook" | "yahoo";

export type ProviderStatus = "available" | "coming_soon";

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  // Short blurb under the name in the picker — names the audience, not the
  // protocol, so end users don't need to know what OAuth is.
  description: string;
  // Single character / glyph rendered inside a colored badge.
  badge: string;
  // Maps to a CSS class `.provider-badge-<id>` defined in emails.css. Keeps
  // brand colors in CSS so we can theme without touching this file.
  status: ProviderStatus;
}

export const EMAIL_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Google Workspace or personal Gmail",
    badge: "G",
    status: "available",
  },
  {
    id: "outlook",
    name: "Outlook",
    description: "Microsoft 365 or Outlook.com",
    badge: "O",
    status: "available",
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    description: "Yahoo.com personal mailboxes",
    badge: "Y",
    // Surfaced as disabled in the picker so enterprise buyers see it on the
    // roadmap without us having to re-tighten the UI when it ships.
    status: "coming_soon",
  },
];

export function getProvider(id: ProviderId): ProviderConfig | undefined {
  return EMAIL_PROVIDERS.find((p) => p.id === id);
}
