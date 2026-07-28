import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import TestAccess from "../test_access/TestAccess";
import AccessRequestsReview from "../accessRequests/AccessRequestsReview";
import "./requests.css";

// One page for both halves of the access-request flow: asking for access and
// (for support) deciding on what others asked for. They were two sidebar
// entries and two pages, which read as unrelated features even though one is
// the queue the other feeds.
type RequestsTab = "mine" | "review";

export default function RequestsPage() {
  const { user } = useAuth();
  // Same permission the review page enforces on itself, checked here so the
  // tab simply isn't offered to people who would be bounced off it.
  const canReview = hasPermission(user, "tickets:manage");

  // The tab lives in the URL so a deep link (and the /access-requests redirect)
  // can land on the right half.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: RequestsTab =
    requested === "review" && canReview
      ? "review"
      : requested === "mine"
        ? "mine"
        : canReview
          ? "review"
          : "mine";

  const selectTab = (next: RequestsTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true }
    );
  };

  return (
    <main className="requests-page">
      <header className="requests-header">
        <h1>Requests</h1>
        <p>
          Ask for access to locked data
          {canReview ? ", and decide on what your team has been asked for" : ""}
          .
        </p>
      </header>

      {canReview && (
        <nav className="requests-tabs" role="tablist" aria-label="Requests">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "review"}
            className={`requests-tab ${tab === "review" ? "active" : ""}`}
            onClick={() => selectTab("review")}
          >
            Review queue
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mine"}
            className={`requests-tab ${tab === "mine" ? "active" : ""}`}
            onClick={() => selectTab("mine")}
          >
            My access
          </button>
        </nav>
      )}

      {tab === "review" && canReview ? (
        <AccessRequestsReview embedded />
      ) : (
        <TestAccess embedded />
      )}
    </main>
  );
}
