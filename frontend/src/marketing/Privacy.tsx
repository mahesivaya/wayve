import type { ReactNode } from "react";
import { BRAND_NAME, HEADER_NAME } from "../config/brand";
import MarketingShell from "./MarketingShell";
import "./privacy.css";

// Public privacy policy at /privacy. Google's OAuth verification requires this
// URL (on the same domain as the home page, linked from it) and requires it to
// carry the Google API Services User Data Policy "Limited Use" disclosure — see
// the "Google user data" sections below. Keep the scope table in sync with the
// scopes requested in backend/crates/wayve-server/src/email/oauth_flow.rs.

const EFFECTIVE_DATE = "October 25, 2026";
const CONTACT_EMAIL = "mahesh@fluxze.com";
const USER_DATA_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";

const GOOGLE_SCOPES: { scope: string; access: string; use: string }[] = [
  {
    scope: "userinfo.email",
    access: "The email address of the Google account you connect.",
    use: "To identify the connected mailbox and confirm it matches the address you sign in with.",
  },
  {
    scope: "gmail.readonly",
    access: "Your Gmail messages, threads, labels and attachments.",
    use: "To show your inbox, conversations, search results and attachments in the app.",
  },
  {
    scope: "gmail.modify",
    access: "The state and labels of your Gmail messages.",
    use: "To apply the actions you take in the app — mark read or unread, star, label, move to Trash and restore — to your Gmail account.",
  },
  {
    scope: "gmail.send",
    access: "Sending email from your Gmail account.",
    use: "To send the messages, replies and meeting invitations you write and choose to send. We never send email you have not asked us to send.",
  },
  {
    scope: "calendar.readonly",
    access: "Your Google Calendar events.",
    use: "To show your upcoming events in the Calendar view and remind you before meetings start.",
  },
  {
    scope: "contacts.readonly, contacts.other.readonly",
    access:
      "Names, email addresses and photos of your saved and automatically collected Google contacts.",
    use: "To suggest recipients and show their profile photos while you write an email.",
  },
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="legal-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export default function Privacy() {
  return (
    <MarketingShell>
      <article className="legal-page">
        <header className="legal-head">
          <p className="legal-eyebrow">Legal</p>
          <h1>Privacy Policy</h1>
          <p className="legal-meta">Effective {EFFECTIVE_DATE}</p>
        </header>

        <p>
          This policy explains how {BRAND_NAME} (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;) collects, uses, stores and shares information when
          you use the email, calendar, chat and workspace app at fluxze.com,
          shown in the app as {HEADER_NAME} (the &ldquo;Service&rdquo;). It
          includes how we handle information we receive from Google APIs when
          you connect a Google account.
        </p>

        <Section id="collect" title="1. Information we collect">
          <ul>
            <li>
              <strong>Account information:</strong> your name, email address,
              password (stored only as a bcrypt hash), account type,
              organization membership and role, and any profile photo you
              upload.
            </li>
            <li>
              <strong>Content you create in the Service:</strong> chat messages,
              notes, files you upload to Drive, tasks, tickets and meetings you
              schedule.
            </li>
            <li>
              <strong>Connected mailbox and calendar data:</strong> when you
              connect a Google or Microsoft account, the data described in
              section 2.
            </li>
            <li>
              <strong>Billing information:</strong> payments are processed by
              Stripe. We store your plan, subscription status and invoices; we
              do not store full card numbers.
            </li>
            <li>
              <strong>Usage and device information:</strong> IP address, browser
              type, the pages you view, the buttons and links you click and the
              requests your browser makes within the Service. On our public
              website we record visits (IP address, browser type, page,
              referring page and an approximate location derived from the IP
              address).
            </li>
            <li>
              <strong>Communications with us:</strong> support tickets and
              emails you send us.
            </li>
          </ul>
        </Section>

        <Section id="google-data" title="2. Information we access from Google">
          <p>
            We access Google user data only after you connect your Google
            account and grant permission on Google&rsquo;s consent screen. We
            request the following permissions:
          </p>
          <div className="legal-table-wrap">
            <table className="legal-table">
              <thead>
                <tr>
                  <th scope="col">Permission</th>
                  <th scope="col">What we access</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {GOOGLE_SCOPES.map((s) => (
                  <tr key={s.scope}>
                    <td>
                      <code>{s.scope}</code>
                    </td>
                    <td>{s.access}</td>
                    <td>{s.use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            If you connect a Microsoft (Outlook) account instead, we access the
            equivalent mailbox and calendar data through Microsoft Graph, for
            the same purposes.
          </p>
        </Section>

        <Section id="google-use" title="3. How we use Google user data">
          <p>
            We use Google user data only to provide and improve the user-facing
            features of the Service that you see and use: displaying, searching
            and organizing your email; sending the email you write; showing your
            calendar and meeting reminders; suggesting recipients; and, if you
            use it, answering your requests in the in-app AI assistant (section
            5). We do not use Google user data for advertising, and we do not
            sell it.
          </p>
        </Section>

        <Section
          id="limited-use"
          title="4. Google API Services User Data Policy — Limited Use"
        >
          <p className="legal-callout">
            {BRAND_NAME}&rsquo;s use and transfer to any other app of
            information received from Google APIs will adhere to the{" "}
            <a href={USER_DATA_POLICY_URL} target="_blank" rel="noreferrer">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
          <p>In particular:</p>
          <ul>
            <li>
              We use Google user data only to provide or improve user-facing
              features that are prominent in the Service&rsquo;s user interface.
            </li>
            <li>
              We do not transfer Google user data to others except as necessary
              to provide or improve those features, to comply with applicable
              law, for security purposes, or as part of a merger, acquisition or
              sale of assets with your prior consent.
            </li>
            <li>
              We do not use or transfer Google user data to serve
              advertisements, including retargeting, personalized or
              interest-based advertising.
            </li>
            <li>
              We do not allow humans to read Google user data unless we have
              your affirmative agreement for specific messages, it is necessary
              for security purposes such as investigating abuse, it is necessary
              to comply with applicable law, or the data has been aggregated and
              anonymized for internal operations.
            </li>
            <li>
              We do not use Google user data, including data from Google
              Workspace APIs, to develop, improve or train generalized
              artificial intelligence or machine learning models.
            </li>
            <li>
              We do not sell Google user data, and we do not use it to determine
              creditworthiness or for lending purposes.
            </li>
          </ul>
        </Section>

        <Section id="ai" title="5. AI features">
          <p>
            The in-app AI assistant is optional. When you ask it something that
            needs your mail or calendar, it can look up the subject, sender,
            date and read status of your recent emails, or your upcoming
            meetings, and send that to the AI provider that processes your
            request: Anthropic (Claude) or Google (Gemini) — or, for
            organization accounts, the provider your organization&rsquo;s
            administrator has configured. This happens only in response to your
            request, to produce the answer shown to you. Emails the assistant
            drafts are never sent without your confirmation.
          </p>
          <p>
            We use AI providers under terms that do not permit them to use this
            data to train their models, and we do not use it to train models
            ourselves.
          </p>
        </Section>

        <Section id="security" title="6. How we store and protect information">
          <ul>
            <li>
              The Service is hosted on Amazon Web Services in the United States.
            </li>
            <li>All traffic to the Service is encrypted in transit (TLS).</li>
            <li>
              Email bodies and the OAuth tokens that let us access your mailbox
              are encrypted at rest with AES-256-GCM.
            </li>
            <li>
              New direct and channel chat messages are end-to-end encrypted in
              your browser before they reach our servers.
            </li>
            <li>
              Access to production systems is limited to authorized personnel
              who need it to operate the Service.
            </li>
          </ul>
        </Section>

        <Section id="sharing" title="7. How we share information">
          <p>
            We do not sell personal information or share it for advertising. We
            share it only with service providers that help us run the Service,
            under obligations to protect it and use it only on our behalf:
          </p>
          <ul>
            <li>Amazon Web Services — hosting and storage.</li>
            <li>Stripe — payment processing and billing.</li>
            <li>
              Anthropic and Google — AI processing when you use the AI assistant
              (section 5); Google also delivers the account emails we send you,
              such as verification codes.
            </li>
            <li>
              Cloudflare — relaying audio and video calls, which stay encrypted
              end to end in transit.
            </li>
            <li>
              Services you choose to connect (for example Slack, GitHub, GitLab,
              Figma, Atlassian, Zoom or Microsoft) — only the data needed for
              the integration you turned on.
            </li>
          </ul>
          <p>
            We may also disclose information if required by law or legal
            process, to protect the rights, safety and security of our users or
            the Service, or as part of a merger or acquisition, in which case we
            will notify you before your information becomes subject to a
            different privacy policy.
          </p>
        </Section>

        <Section id="retention" title="8. Retention and deletion">
          <ul>
            <li>
              We keep your information for as long as your account is active.
            </li>
            <li>
              <strong>Disconnecting a mailbox</strong> deletes it from the
              Service, along with its stored access tokens and every email we
              synced from it. You can also revoke our access at any time from
              your{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer"
              >
                Google Account permissions
              </a>{" "}
              page; after that we can no longer access your Google data.
            </li>
            <li>
              <strong>Deleting your account</strong> (Settings → Danger zone)
              permanently deletes it and the data associated with it, including
              connected mailboxes and their emails. Organization owners delete
              the organization first, and an active subscription must be
              cancelled first. You can also ask us to delete your account by
              emailing us.
            </li>
            <li>
              Deleted data may remain in backups for a limited period before
              those backups are removed. We keep billing records for as long as
              tax and accounting law requires. Website visit records are kept
              without a link to your account once it is deleted.
            </li>
          </ul>
        </Section>

        <Section id="cookies" title="9. Cookies and local storage">
          <p>
            We use a sign-in cookie to keep you logged in, and your
            browser&rsquo;s local storage to remember preferences such as your
            theme and layout. We do not use advertising or third-party tracking
            cookies.
          </p>
        </Section>

        <Section id="rights" title="10. Your choices and rights">
          <p>
            You can view and update your profile in Settings, disconnect
            mailboxes, and delete your account at any time. Depending on where
            you live, you may also have the right to request access to, a copy
            of, correction of or deletion of your personal information, or to
            object to certain processing. To make a request, email us at the
            address below; we will respond within 30 days.
          </p>
        </Section>

        <Section id="children" title="11. Children">
          <p>
            The Service is not directed to children under 13 (or under 16 where
            local law requires), and we do not knowingly collect their personal
            information. If you believe a child has given us personal
            information, contact us and we will delete it.
          </p>
        </Section>

        <Section id="changes" title="12. Changes to this policy">
          <p>
            We may update this policy from time to time. We will change the
            effective date above, and for material changes we will notify you in
            the Service or by email before they take effect.
          </p>
        </Section>

        <Section id="contact" title="13. Contact us">
          <p>
            Questions or requests about this policy or your data:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </Section>
      </article>
    </MarketingShell>
  );
}
