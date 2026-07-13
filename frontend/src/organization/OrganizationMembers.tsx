import { FormEvent, useState } from "react";
import {
  createAdminUser,
  sendAdminCreateCode,
  type AdminCreatedUser,
} from "../api/admin";
import { slugify, getEmailDomain } from "../auth/accountHome";
import { useAuth } from "../auth/useAuth";
import { hasPermission, ROLE_LABELS, type Role } from "../auth/permissions";
import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./organizationAdmin.css";

// Roles an org admin can assign at creation time (below owner / super_admin,
// which are promoted via the per-member role change instead).
const CREATE_ROLE_OPTIONS: Role[] = [
  "member",
  "guest",
  "support",
  "developer",
  "billing",
  "security",
  "admin",
];

export default function OrganizationMembers() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");

  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  // Email defaults to <handle>@<org-domain> but is editable; once the admin
  // types in it, we stop auto-syncing it from the handle.
  const [email, setEmail] = useState("");
  const [emailEdited, setEmailEdited] = useState(false);
  const [createdUsers, setCreatedUsers] = useState<AdminCreatedUser[]>([]);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [creating, setCreating] = useState(false);

  // Where the verification code is mailed. Defaults to the account email, but
  // stays editable: an org account's login address is on the synthetic org
  // domain (<user>@<slug>.com), which has no inbox, so the code has to go to
  // the person's real mailbox instead.
  const [deliveryEmail, setDeliveryEmail] = useState("");
  const [deliveryEdited, setDeliveryEdited] = useState(false);
  // Set once a code has been mailed — flips the form from step 1 to step 2.
  const [codeSentTo, setCodeSentTo] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);

  const orgSlug =
    user?.organization_slug || slugify(user?.organization_name ?? "");
  const emailDomain = getEmailDomain(orgSlug);
  const generatedEmail = handle ? `${slugify(handle)}@${emailDomain}` : "";
  const effectiveEmail = emailEdited ? email.trim() : generatedEmail;
  const effectiveDelivery = deliveryEdited
    ? deliveryEmail.trim()
    : effectiveEmail;

  const resetForm = () => {
    setHandle("");
    setPassword("");
    setRole("member");
    setEmail("");
    setEmailEdited(false);
    setDeliveryEmail("");
    setDeliveryEdited(false);
    setCodeSentTo("");
    setCode("");
  };

  // Step 1 — mail the code. No account exists yet at this point.
  const sendCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreateSuccess("");
    setSending(true);

    try {
      const sent = await sendAdminCreateCode(effectiveEmail, effectiveDelivery);
      setCodeSentTo(sent.delivery_email);
      setCode("");
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to send verification code"
      );
    } finally {
      setSending(false);
    }
  };

  // Step 2 — hand the code back; the account is created only if it checks out.
  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreateSuccess("");
    setCreating(true);

    try {
      const created = await createAdminUser(
        handle,
        effectiveEmail,
        password,
        "personal",
        "",
        role,
        code.trim()
      );
      setCreatedUsers((prev) => [created, ...prev]);
      resetForm();
      setCreateSuccess(`Created account ${created.email}`);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create user"
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="organization-admin-home u-page-shell">
      {canManageMembers && (
        <section className="organization-admin-create u-panel">
          <div className="organization-admin-section-header">
            <div>
              <h2>Create account</h2>
              <p>
                Add a new account inside your organization. Enter a username -
                the email is generated automatically. We email a verification
                code before the account is created.
              </p>
            </div>
          </div>

          {!codeSentTo ? (
            <form className="organization-admin-form" onSubmit={sendCode}>
              <label className="u-form-label">
                <span className="u-form-label-text">Username</span>
                <input
                  className="u-form-control"
                  value={handle}
                  onChange={(event) => setHandle(event.target.value)}
                  placeholder="e.g. john"
                  required
                />
              </label>

              <label className="u-form-label">
                <span className="u-form-label-text">Email</span>
                <input
                  className="u-form-control"
                  type="email"
                  value={effectiveEmail}
                  onChange={(event) => {
                    setEmailEdited(true);
                    setEmail(event.target.value);
                  }}
                  placeholder={generatedEmail || "name@example.com"}
                  required
                />
              </label>

              <label className="u-form-label">
                <span className="u-form-label-text">Send code to</span>
                <input
                  className="u-form-control"
                  type="email"
                  value={effectiveDelivery}
                  onChange={(event) => {
                    setDeliveryEdited(true);
                    setDeliveryEmail(event.target.value);
                  }}
                  placeholder="name@example.com"
                  required
                />
              </label>

              <label className="u-form-label">
                <span className="u-form-label-text">Role</span>
                <select
                  className="u-form-control"
                  value={role}
                  onChange={(event) => setRole(event.target.value as Role)}
                >
                  {CREATE_ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="u-form-label">
                <span className="u-form-label-text">Password</span>
                <input
                  className="u-form-control"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 6 characters"
                  minLength={6}
                  required
                />
              </label>

              <button
                className="u-btn-primary"
                type="submit"
                disabled={sending}
              >
                {sending ? "Sending code..." : "Send code"}
              </button>
            </form>
          ) : (
            <form className="organization-admin-form" onSubmit={createUser}>
              <p className="organization-admin-code-sent">
                We emailed a 6-digit code to <strong>{codeSentTo}</strong>.
                Enter it to create <strong>{effectiveEmail}</strong>.
              </p>

              <label className="u-form-label">
                <span className="u-form-label-text">Verification code</span>
                <input
                  className="u-form-control"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  required
                />
              </label>

              <button
                className="u-btn-primary"
                type="submit"
                disabled={creating}
              >
                {creating ? "Creating..." : "Create account"}
              </button>
              <button
                type="button"
                className="u-btn-secondary"
                onClick={() => {
                  setCodeSentTo("");
                  setCode("");
                  setCreateError("");
                }}
                disabled={creating}
              >
                Edit details
              </button>
            </form>
          )}

          {createError && (
            <div className="organization-admin-error">{createError}</div>
          )}
          {createSuccess && (
            <div className="organization-admin-success">{createSuccess}</div>
          )}

          {createdUsers.length > 0 && (
            <div className="organization-admin-created-list">
              {createdUsers.map((created) => (
                <div
                  key={created.id}
                  className="organization-admin-created-row"
                >
                  <strong>{created.username || created.email}</strong>
                  <span>
                    {created.email} · {created.account_type}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {user?.organization_id != null && (
        <MembersRolesPanel
          scope="organization"
          organizationId={user.organization_id}
        />
      )}
    </div>
  );
}
