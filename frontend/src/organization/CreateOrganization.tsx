import { FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { createMyOrganization } from "../api/admin";
import "./createOrganization.css";

/**
 * Self-serve organization setup page. Personal users land here after
 * clicking "Create organization" on the Billing page's org-audience plans.
 * Form captures the org name + place (free-form locale). On submit the
 * caller is promoted to organization_admin (owner role), the AuthContext
 * is refreshed, and they're sent to /organization-home — the canonical
 * dashboard for organization users. Adding members is handled separately
 * from the org home's "Members & roles" surface, so this page stays
 * single-purpose.
 *
 * The `?plan=<code>` query param (if present) is forwarded as a hint so
 * the org home can surface "you started with the X plan — subscribe to
 * activate it" copy. Not load-bearing yet.
 */
export default function CreateOrganization() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const intendedPlan = params.get("plan") || "";

  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const isPersonal = (user?.account_type ?? "personal") === "personal";

  const submitOrg = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreating(true);
    try {
      await createMyOrganization({
        name: name.trim(),
        place: place.trim() || undefined,
      });
      // /api/me now reflects the promoted account_type + org info. Refresh
      // so the Header re-renders for the new scope before we navigate.
      await refresh();
      const target = intendedPlan
        ? `/organization-home?plan=${encodeURIComponent(intendedPlan)}`
        : "/organization-home";
      navigate(target, { replace: true });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  // Guard: only personal users may self-serve a new org. If the caller is
  // already org/platform, bounce them to their home. (Backend enforces the
  // same rule with a 409 conflict; the guard avoids surfacing an empty
  // form to users who can't submit it.)
  if (!isPersonal) {
    return (
      <div className="create-org-page">
        <div className="create-org-card">
          <h1>Organization setup</h1>
          <p>
            Your account already belongs to an organization or platform
            scope, so you can't create a new organization from here.
          </p>
          <button
            type="button"
            className="create-org-primary"
            onClick={() => navigate("/")}
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="create-org-page">
      <section className="create-org-card">
        <header className="create-org-header">
          <h1>Create your organization</h1>
          <p>
            Organization plans cover the whole team — shared inboxes,
            multi-seat, billing rollup. You'll become the organization's
            owner; your existing emails, chats, and files stay on this
            account.
          </p>
        </header>
        <form className="create-org-form" onSubmit={submitOrg}>
          <label className="create-org-label">
            <span>Organization name</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Acme Inc."
              autoFocus
            />
          </label>
          <label className="create-org-label">
            <span>Place <small>(optional — city, country, or address)</small></span>
            <input
              maxLength={200}
              value={place}
              onChange={(event) => setPlace(event.target.value)}
              placeholder="e.g. San Francisco, CA"
            />
          </label>
          <p className="create-org-note">
            Your account becomes the organization's owner. If you change
            your mind later, you can revert to a personal account from the
            organization home page.
          </p>
          {createError && (
            <p className="create-org-error">{createError}</p>
          )}
          <div className="create-org-actions">
            <button
              type="submit"
              className="create-org-primary"
              disabled={creating || !name.trim()}
            >
              {creating ? "Creating…" : "Create organization"}
            </button>
            <button
              type="button"
              className="create-org-secondary"
              disabled={creating}
              onClick={() => navigate("/billing")}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
