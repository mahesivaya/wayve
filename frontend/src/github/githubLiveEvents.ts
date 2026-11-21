// GitHub updates the server pushes (`github:*` frames, e.g. `github:pulls`).
// They ride the same per-user WebSocket as chat and email; the chat socket
// hands them here instead of treating them as messages, and anything that
// cares (the Code & reviews page) listens for them.

export const GITHUB_EVENT = "rwayve:github-event";

export type GithubLiveEvent = { type: string } & Record<string, unknown>;

/** Re-broadcast one `github:*` frame from the shared socket. */
export function announceGithubEvent(frame: GithubLiveEvent): void {
  window.dispatchEvent(
    new CustomEvent<GithubLiveEvent>(GITHUB_EVENT, { detail: frame })
  );
}

/** Listen for `github:*` frames; returns the function that stops listening. */
export function onGithubEvent(
  listener: (frame: GithubLiveEvent) => void
): () => void {
  const handler = (event: Event) => {
    const frame = (event as CustomEvent<GithubLiveEvent>).detail;
    if (frame) listener(frame);
  };
  window.addEventListener(GITHUB_EVENT, handler);
  return () => window.removeEventListener(GITHUB_EVENT, handler);
}
