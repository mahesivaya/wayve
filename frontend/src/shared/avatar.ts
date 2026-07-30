// Generated initial-avatars for people/addresses that have no uploaded photo.
// Shared by the email sender meta, the reply @mention picker, and the compose
// "To" contacts typeahead so the same seed always yields the same color.

const AVATAR_PALETTE = [
  "#d7b29c",
  "#7c9eb2",
  "#a8c686",
  "#c89bb0",
  "#8d8aaa",
  "#e0a36d",
  "#6d9eb8",
  "#b8857a",
];

// Hashed rather than random, so a seed keeps the same color across sessions.
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

/** First letter of the seed, uppercased, falling back to "?". */
export function avatarInitial(seed: string): string {
  return (seed || "?").trim().charAt(0).toUpperCase() || "?";
}
