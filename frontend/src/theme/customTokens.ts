// The tokens a user may override at runtime. Brand identity tokens (gradient
// cards, provider brand colors, hero accents) are deliberately excluded: they
// are identity, not theme.

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
  | "canvas"
  | "pane"
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

// These names must stay in sync with src/index.css; the customizer writes each
// override as `--color-<name>` on :root.
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
  // The page backgrounds must be themeable, or a generated theme (B&W above all)
  // leaves a static color showing through behind everything.
  canvas: "--color-canvas",
  pane: "--color-pane",
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
