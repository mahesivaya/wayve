import { MAILPIT_API } from "./env";

// Mailpit captures SMTP messages and exposes them over a JSON API. Used by
// password-reset tests to read the token Wayve mails out without spelunking
// through the database.
//
// Wire format reference: https://mailpit.axllent.org/docs/api-v1/

type MailpitListEntry = {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
};

type MailpitList = {
  total: number;
  count: number;
  messages: MailpitListEntry[];
};

type MailpitMessage = {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
  Text: string;
  HTML: string;
};

// Poll Mailpit until a message addressed to `recipient` arrives. Returns
// the plaintext body so callers can grep for tokens / URLs. 10s default cap
// matches the reset-token TTL window with margin.
export async function waitForEmailTo(
  recipient: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const wanted = recipient.toLowerCase();

  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages`);
    if (res.ok) {
      const list = (await res.json()) as MailpitList;
      const match = list.messages.find((m) =>
        m.To.some((to) => to.Address.toLowerCase() === wanted),
      );
      if (match) {
        // Mailpit's list endpoint doesn't include the body — fetch the
        // detail record to get Text/HTML.
        const detailRes = await fetch(`${MAILPIT_API}/api/v1/message/${match.ID}`);
        if (detailRes.ok) {
          const detail = (await detailRes.json()) as MailpitMessage;
          return detail.Text || detail.HTML || "";
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`No mail received at ${recipient} within ${timeoutMs}ms`);
}

// Delete every message in Mailpit. Useful in `beforeEach` so a test that
// looks for "the latest email to alice@…" doesn't accidentally pick up
// a stale message from a previous run.
export async function purgeAllEmail(): Promise<void> {
  await fetch(`${MAILPIT_API}/api/v1/messages`, { method: "DELETE" });
}
