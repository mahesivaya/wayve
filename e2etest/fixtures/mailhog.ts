import { MAILHOG_API } from "./env";

// MailHog stores received SMTP messages in memory and exposes them over
// a JSON API. Used by password-reset tests to read the token Wayve mails
// out without spelunking through the database.
//
// Wire format reference: https://github.com/mailhog/MailHog/blob/master/docs/APIv2.md

type MailHogMessage = {
  ID: string;
  Content: {
    Headers: Record<string, string[]>;
    Body: string;
  };
  To: Array<{ Mailbox: string; Domain: string }>;
};

type MailHogList = {
  total: number;
  count: number;
  items: MailHogMessage[];
};

// Poll MailHog until a message addressed to `recipient` arrives. Returns
// the raw body so callers can grep for tokens / URLs. 10s default cap
// matches the reset-token TTL window with margin.
export async function waitForEmailTo(
  recipient: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${MAILHOG_API}/api/v2/messages`);
    if (res.ok) {
      const list = (await res.json()) as MailHogList;
      const match = list.items.find((m) =>
        m.To.some((to) => `${to.Mailbox}@${to.Domain}`.toLowerCase() === recipient.toLowerCase()),
      );
      if (match) return match.Content.Body;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`No mail received at ${recipient} within ${timeoutMs}ms`);
}

// Delete every message in MailHog. Useful in `beforeEach` so a test that
// looks for "the latest email to alice@…" doesn't accidentally pick up
// a stale message from a previous run.
export async function purgeAllEmail(): Promise<void> {
  await fetch(`${MAILHOG_API}/api/v1/messages`, { method: "DELETE" });
}
