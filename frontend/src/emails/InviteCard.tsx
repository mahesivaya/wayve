import { useEffect, useState } from "react";
import { getEmailInvite, type EmailInvite } from "../api/email";
import { InviteIcon } from "../icons";
import { inviteLabel, inviteWhen, safeJoinUrl } from "./inviteFormat";

// The meeting in an invitation email, above its body: what, when (in the
// viewer's time zone), where, a Join link, and who organized it. Loaded when
// the email opens. Nothing shows if the email turns out to carry no readable
// invitation; a failure to load says so quietly rather than blocking the email.
// Hosts key it by email, so each email starts from "loading".
export function InviteCard({ emailId }: { emailId: number }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; invite: EmailInvite | null }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let live = true;
    getEmailInvite(emailId)
      .then((invite) => live && setState({ status: "ready", invite }))
      .catch(
        (err: unknown) =>
          live &&
          setState({
            status: "error",
            message:
              err instanceof Error ? err.message : "Couldn't load the invitation",
          })
      );
    return () => {
      live = false;
    };
  }, [emailId]);

  if (state.status === "loading") {
    return (
      <div className="invite-card invite-card--loading" aria-busy="true">
        <InviteIcon size={18} aria-hidden="true" />
        <span>Loading invitation…</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="invite-card invite-card--error" role="status">
        <InviteIcon size={18} aria-hidden="true" />
        <span>{state.message}</span>
      </div>
    );
  }
  const { invite } = state;
  if (!invite) return null;

  const label = inviteLabel(invite);
  const when = inviteWhen(invite);
  const joinUrl = safeJoinUrl(invite.join_url);
  const organizer = invite.organizer_name
    ? invite.organizer_email
      ? `${invite.organizer_name} <${invite.organizer_email}>`
      : invite.organizer_name
    : invite.organizer_email;

  return (
    <section
      className={`invite-card${label === "Cancelled" ? " invite-card--cancelled" : ""}`}
      aria-label="Meeting invitation"
    >
      <InviteIcon size={22} className="invite-card-icon" aria-hidden="true" />
      <div className="invite-card-body">
        <span className="invite-card-label">{label}</span>
        <strong className="invite-card-title">
          {invite.title || "(No title)"}
        </strong>
        {when && <span className="invite-card-when">{when}</span>}
        {invite.location && (
          <span className="invite-card-detail">{invite.location}</span>
        )}
        {organizer && (
          <span className="invite-card-detail">Organizer: {organizer}</span>
        )}
      </div>
      {joinUrl && label !== "Cancelled" && (
        <a
          className="invite-card-join"
          href={joinUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Join meeting
        </a>
      )}
    </section>
  );
}
