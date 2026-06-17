// Catalog of CSS custom properties the user can override at runtime via
// the theme customizer. A small set on purpose — these are the tokens that
// shape the perceived identity of the app. Brand identity tokens
// (gradient cards, provider brand colors, hero accents) are intentionally
// NOT in this list: they're identity, not theme.

export type TokenRole =
  | "primary"
  | "primary-hover"
  | "primary-action"
  | "primary-action-hover"
  | "primary-soft"
  | "accent-indigo"
  | "accent-purple"
  | "surface"
  | "surface-soft"
  | "surface-hover"
  | "email-bg"
  | "email-list-bg"
  | "text-primary"
  | "text-secondary"
  | "text-muted"
  | "text-ink"
  | "border"
  | "border-soft"
  | "border-muted"
  | "success"
  | "success-soft"
  | "danger"
  | "danger-soft"
  | "warning"
  | "warning-soft";

// The mapping from semantic role → underlying CSS custom property name. The
// customizer writes overrides as `--color-<name>: <value>` on :root. Keep
// the names in sync with src/index.css.
export const TOKEN_VAR: Record<TokenRole, string> = {
  primary: "--color-primary",
  "primary-hover": "--color-primary-hover",
  "primary-action": "--color-primary-action",
  "primary-action-hover": "--color-primary-action-hover",
  "primary-soft": "--color-primary-soft",
  "accent-indigo": "--color-accent-indigo",
  "accent-purple": "--color-accent-purple",
  surface: "--color-surface",
  "surface-soft": "--color-surface-soft",
  "surface-hover": "--color-surface-hover",
  // Full-page content-area backgrounds (the split-pane canvas + email list
  // pane). Themeable so a generated theme — especially B&W — neutralizes them
  // instead of leaving the static `lightsteelblue` showing through.
  "email-bg": "--color-email-bg",
  "email-list-bg": "--color-email-list-bg",
  "text-primary": "--color-text-primary",
  "text-secondary": "--color-text-secondary",
  "text-muted": "--color-text-muted",
  "text-ink": "--color-text-ink",
  border: "--color-border",
  "border-soft": "--color-border-soft",
  "border-muted": "--color-border-muted",
  success: "--color-success",
  "success-soft": "--color-success-soft",
  danger: "--color-danger",
  "danger-soft": "--color-danger-soft",
  warning: "--color-warning",
  "warning-soft": "--color-warning-soft",
};

export type TokenOverrides = Partial<Record<TokenRole, string>>;

export const ALL_ROLES: TokenRole[] = Object.keys(TOKEN_VAR) as TokenRole[];
