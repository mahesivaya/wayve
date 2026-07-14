// Single source of truth for the mailbox-provider picker. Adding a provider is
// an entry here plus a dispatch arm in Emails.tsx; EmailSidebar and
// ProviderPicker read this list and need no edits.

export type ProviderId = "gmail" | "outlook";

export type ProviderStatus = "available" | "coming_soon";

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  // Names the audience rather than the protocol, so end users don't need to
  // know what OAuth is.
  description: string;
  // Single glyph rendered inside a colored badge; brand colors live in
  // emails.css under `.provider-badge-<id>`.
  badge: string;
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
];

export function getProvider(id: ProviderId): ProviderConfig | undefined {
  return EMAIL_PROVIDERS.find((p) => p.id === id);
}
