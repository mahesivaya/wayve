// Single source of truth for the product brand name shown in the UI
// (headers, footer, logo, page titles). Rename here to rebrand everywhere
// that displays the product name.
//
// NOTE: on-the-wire / code identifiers that happen to contain the old name —
// e.g. the `X-Wayve-Signature` webhook header, the `WAYVE_CHAT_E2E_V1` chat
// envelope tag, and type/function names like `WayveEncryptedBody` — are
// deliberately NOT derived from this constant. They are stable protocol
// values and must not change when the brand name changes.
export const BRAND_NAME = "Fluxze";
