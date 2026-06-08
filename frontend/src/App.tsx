import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

// /services/:slug → /docs/services/:slug. Native <Navigate to="..."/>
// can't include a dynamic `:slug` from the URL, so this tiny wrapper
// reads the param via useParams and forwards.
function LegacyServiceRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/docs/services/${slug ?? ""}`} replace />;
}

import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import RequirePricingAccess from "./components/RequirePricingAccess";
import Register from "./auth/Register";
import Login from "./auth/Login";
import ForgotPassword from "./auth/ForgotPassword";
import ResetPassword from "./auth/ResetPassword";
import RecoverWithMnemonicPage from "./auth/RecoverWithMnemonic";
import { useAuth } from "./auth/useAuth";
import { homePathForUser, normalizeAccountType } from "./auth/accountHome";

// 🔥 Lazy loaded pages
const Home = lazy(() => import("./home/Home"));
const Emails = lazy(() => import("./emails/Emails"));
const Chat = lazy(() => import("./chat/Chat"));
const Call = lazy(() => import("./call/Call"));
const Scheduler = lazy(() => import("./scheduler/Scheduler"));
const Drive = lazy(() => import("./drive/DriveBox"));
const Notes = lazy(() => import("./notes/Notes"));
const Tasks = lazy(() => import("./tasks/Tasks"));
const AIChat = lazy(() => import("./aichat/AIChat"));
const GitHubRepo = lazy(() => import("./github/GitHubRepo"));
const TeamPage = lazy(() => import("./teams/TeamPage"));
const DomainVerification = lazy(() => import("./orgDomains/DomainVerification"));
const About = lazy(() => import("./about/About"));
const Profile = lazy(() => import("./profile/Profile"));
const Settings = lazy(() => import("./profile/Settings"));
const Organization = lazy(() => import("./organization/Organization"));
const OrganizationAdminHome = lazy(() => import("./organization/OrganizationAdminHome"));
const OrganizationMembers = lazy(() => import("./organization/OrganizationMembers"));
const PlatformAdminHome = lazy(() => import("./organization/PlatformAdminHome"));
const PlatformOrganizations = lazy(() => import("./organization/PlatformOrganizations"));
const PlatformOrganizationDetail = lazy(() => import("./organization/PlatformOrganizationDetail"));
const PlatformUsers = lazy(() => import("./organization/PlatformUsers"));
const PlatformEnterprises = lazy(() => import("./organization/PlatformEnterprises"));
const PlatformMembers = lazy(() => import("./organization/PlatformMembers"));
const OrganizationHome = lazy(() => import("./organization/OrganizationHome"));
const EmailFiles = lazy(() => import("./files/EmailFiles"));
const ServicePage = lazy(() => import("./services/ServicePage"));
const Billing = lazy(() => import("./billing/Billing"));
const CreateOrganization = lazy(() => import("./organization/CreateOrganization"));
const PlatformBilling = lazy(() => import("./platformBilling/PlatformBilling"));
const PlatformDeveloper = lazy(() => import("./platformTeam/PlatformDeveloper"));
const PlatformSupport = lazy(() => import("./platformTeam/PlatformSupport"));
const PlatformAnalytics = lazy(() => import("./platformTeam/PlatformAnalytics"));
const PlatformWelcome = lazy(() => import("./platformTeam/PlatformWelcome"));
const PlatformSecrets = lazy(() => import("./platformTeam/PlatformSecrets"));
const PlatformLogs = lazy(() => import("./platformTeam/PlatformLogs"));
const PlatformUserLogs = lazy(() => import("./platformTeam/PlatformUserLogs"));
const PlatformVisitors = lazy(() => import("./platformTeam/PlatformVisitors"));
const Pricing = lazy(() => import("./pricing/Pricing"));
const Support = lazy(() => import("./marketing/Support"));
const Developers = lazy(() => import("./marketing/Developers"));
const Quotas = lazy(() => import("./marketing/Quotas"));
const Docs = lazy(() => import("./marketing/Docs"));
const SwaggerDocs = lazy(() => import("./marketing/SwaggerDocs"));
const DocsIndex = lazy(() => import("./docs/DocsIndex"));
const ApiKeysPage = lazy(() => import("./apikeys/ApiKeysPage"));
const SsoSettings = lazy(() => import("./settings/SsoSettings"));
const SharedInboxes = lazy(() => import("./settings/SharedInboxes"));
const Webhooks = lazy(() => import("./settings/Webhooks"));
const ScimTokens = lazy(() => import("./settings/ScimTokens"));
const PlanAdmin = lazy(() => import("./settings/PlanAdmin"));
const SecureMessageView = lazy(() => import("./emails/SecureMessageView"));
const AuditSecurity = lazy(() => import("./settings/AuditSecurity"));
const RecoverPage = lazy(() => import("./recovery/RecoverPage"));
const OrgKeyBootstrap = lazy(() => import("./orgKeys/BootstrapPage"));
const OrgRecoveryKey = lazy(() => import("./orgKeys/RecoveryKeyPage"));
const RecoverMemberData = lazy(() => import("./orgKeys/RecoverMemberDataPage"));
const OrgAuditLog = lazy(() => import("./orgKeys/AuditLogPage"));
const TestAccess = lazy(() => import("./test_access/TestAccess"));
const AccessRequestsReview = lazy(
  () => import("./accessRequests/AccessRequestsReview"),
);
const TracingDashboard = lazy(() => import("./tracing/TracingDashboard"));

export default function App() {
  const { user } = useAuth();
  const location = useLocation();

  const accountHome = homePathForUser(user).toLowerCase();

  const accountType = normalizeAccountType(user?.account_type);
  const isOrganizationUser =
    accountType === "organization_admin" ||
    accountType === "organization" ||
    user?.organization_id != null;

  const isAtAccountHome = location.pathname.toLowerCase() === accountHome;

  const redirectToAccountHome =
    isAtAccountHome ? null : (
      <Navigate to={accountHome} replace />
    );

  return (
    <Suspense fallback={null}>
      <Routes>

        {/* ROOT */}
        <Route
          path="/"
          element={user ? redirectToAccountHome ?? <Home /> : <Home />}
        />

        {/* PUBLIC */}
        <Route
          path="/login"
          element={user ? redirectToAccountHome ?? <Login /> : <Login />}
        />
        <Route
          path="/register"
          element={user ? redirectToAccountHome ?? <Register /> : <Register />}
        />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/recover-with-mnemonic"
          element={<RecoverWithMnemonicPage />}
        />
        {/* Plan A Phase 3 — Secure-send magic link. Intentionally
            public: the recipient is not (necessarily) a Wayve user,
            and the passphrase is what actually unlocks the message.
            The page fetches the ciphertext from a no-auth API route
            and decrypts entirely client-side. */}
        <Route path="/m/:token" element={<SecureMessageView />} />
        <Route path="/organization" element={<Organization />} />
        {/* /services/:slug is now /docs/services/:slug — redirect old
            links so any externally-shared URL still lands. */}
        <Route
          path="/services/:slug"
          element={<LegacyServiceRedirect />}
        />
        <Route path="/docs/services/:slug" element={<ServicePage />} />
        {/* Pricing is a public-facing page: anyone (logged out OR in) should
            be able to view plans. It lives here rather than under the
            ProtectedRoute branch so unauth visitors aren't bounced to
            /login. The component renders its own header chrome, so no
            Layout wrapper is needed. */}
        {/* Personal accounts bounce off these surfaces: Pricing redirects
            to Settings (where "Manage billing & upgrade" lives); Developers
            and Docs fall back to the account home. Public visitors and
            organization / platform users pass through unchanged. */}
        <Route
          path="/pricing"
          element={
            <RequirePricingAccess>
              <Pricing />
            </RequirePricingAccess>
          }
        />
        <Route path="/support" element={<Support />} />
        {/* ── Documentation surface ──────────────────────────────────
            Every dev-readable page now lives under /docs/* with a
            shared DocsShell (search + sidebar + breadcrumbs). The
            whole tree is public — anyone, logged-in or not, can
            browse the API contract. Legacy paths (/developers,
            /developers/quotas, /services/:slug) 301-style redirect
            to their /docs/* canonical URL.
            -------------------------------------------------------- */}
        <Route path="/docs" element={<DocsIndex />} />
        <Route path="/docs/api" element={<SwaggerDocs />} />
        <Route path="/docs/developers" element={<Developers />} />
        <Route path="/docs/quotas" element={<Quotas />} />
        {/* Backend markdown catalog — matches anything else under
            /docs/*. Order matters: this must come AFTER the static
            routes above so /docs/api etc. aren't treated as slugs. */}
        <Route path="/docs/:slug" element={<Docs />} />
        {/* Legacy paths — keep external links working forever. */}
        <Route path="/developers" element={<Navigate to="/docs/developers" replace />} />
        <Route path="/developers/quotas" element={<Navigate to="/docs/quotas" replace />} />

        {/* PROTECTED */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Layout />}>

            <Route
              path="/home"
              element={redirectToAccountHome ?? <Home />}
            />
            <Route
              path="/organization/home"
              element={
                isOrganizationUser ? (
                  <OrganizationAdminHome />
                ) : (
                  redirectToAccountHome ?? <OrganizationAdminHome />
                )
              }
            />
            {/* Legacy alias — bookmarks from before the rename. */}
            <Route
              path="/organization-home"
              element={<Navigate to="/organization/home" replace />}
            />
            <Route
              path="/platform/home"
              element={
                // A platform user whose role-derived home is NOT this page
                // (currently: billing → /platform/billing) gets bounced out.
                // Keeps /platform/home from being the landing surface
                // for roles that have no actionable panels on it.
                accountType === "platform_admin" &&
                accountHome === "/platform/home" ? (
                  <PlatformAdminHome />
                ) : (
                  redirectToAccountHome ?? <PlatformAdminHome />
                )
              }
            />
            {/* Legacy alias — bookmarks from before the rename. */}
            <Route
              path="/platform-admin-home"
              element={<Navigate to="/platform/home" replace />}
            />
            <Route path="/organization/members" element={<OrganizationMembers />} />
            <Route
              path="/organization/:slug"
              element={redirectToAccountHome ?? <OrganizationHome />}
            />
            <Route path="/emails" element={<Emails />} />
            <Route path="/emails/attachments" element={<EmailFiles />} />
            {/* Legacy alias. */}
            <Route
              path="/email-files"
              element={<Navigate to="/emails/attachments" replace />}
            />
            <Route path="/chat" element={<Chat />} />
            <Route path="/call" element={<Call />} />
            <Route path="/scheduler" element={<Scheduler />} />
            <Route path="/drive" element={<Drive />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/ai-chat" element={<AIChat />} />
            <Route path="/teams/:slug" element={<TeamPage />} />
            {/* Legacy alias (no hyphen — original spelling). */}
            <Route
              path="/aichat"
              element={<Navigate to="/ai-chat" replace />}
            />
            {/* Platform team, organization owner / super_admin / admin, and
                developers (either scope). Hiding the sidebar link isn't enough
                — guard the route so anyone else typing /github is bounced to
                their own home instead of seeing the page. Keep this in sync
                with `hasWorkspaceSection` in Layout.tsx. */}
            <Route
              path="/github"
              element={
                user?.scope === "platform" ||
                (user?.scope === "organization" &&
                  ["owner", "super_admin", "admin"].includes(
                    user?.effective_role ?? "",
                  )) ||
                user?.effective_role === "developer" ? (
                  <GitHubRepo />
                ) : (
                  <Navigate to={accountHome} replace />
                )
              }
            />
            {/* Platform-owner only: graphical tracing-log dashboard. */}
            <Route
              path="/logs/tracing"
              element={
                user?.scope === "platform" && user?.effective_role === "owner" ? (
                  <TracingDashboard />
                ) : (
                  <Navigate to={accountHome} replace />
                )
              }
            />
            <Route
              path="/platform/tracing"
              element={<Navigate to="/logs/tracing" replace />}
            />
            {/* Platform-owner only: domain administration for organizations. */}
            <Route
              path="/platform/domains"
              element={
                user?.scope === "platform" && user?.effective_role === "owner" ? (
                  <DomainVerification />
                ) : (
                  <Navigate to={accountHome} replace />
                )
              }
            />
            <Route path="/about" element={<About />} />
            <Route path="/test-access" element={<TestAccess />} />
            <Route
              path="/access-requests"
              element={
                (user?.scope === "organization" ||
                  user?.scope === "platform") &&
                user?.effective_role === "owner" ? (
                  <AccessRequestsReview />
                ) : (
                  <Navigate to={accountHome} replace />
                )
              }
            />
            <Route path="/profile" element={<Profile />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/organizations/new" element={<CreateOrganization />} />
            <Route path="/platform/organizations" element={<PlatformOrganizations />} />
            <Route path="/platform/organizations/:id" element={<PlatformOrganizationDetail />} />
            <Route path="/platform/users" element={<PlatformUsers />} />
            <Route path="/platform/enterprise" element={<PlatformEnterprises />} />
            <Route path="/platform/members" element={<PlatformMembers />} />
            <Route path="/platform/billing" element={<PlatformBilling />} />
            <Route path="/platform/developer" element={<PlatformDeveloper />} />
            <Route path="/platform/support" element={<PlatformSupport />} />
            <Route path="/platform/analytics" element={<PlatformAnalytics />} />
            <Route path="/platform/welcome" element={<PlatformWelcome />} />
            <Route path="/platform/secrets" element={<PlatformSecrets />} />
            {/* All log/audit surfaces live under one /logs/* namespace.
                The old /platform/*, /organization/logs and /security/audit
                paths below redirect here so bookmarks keep working. */}
            <Route path="/logs" element={<Navigate to="/logs/app" replace />} />
            <Route path="/logs/app" element={<PlatformLogs />} />
            <Route path="/logs/users" element={<PlatformUserLogs />} />
            <Route path="/logs/audit" element={<AuditSecurity />} />
            <Route path="/logs/visitors" element={<PlatformVisitors />} />
            <Route path="/platform/logs" element={<Navigate to="/logs/app" replace />} />
            <Route path="/organization/logs" element={<Navigate to="/logs/app" replace />} />
            <Route path="/platform/user-logs" element={<Navigate to="/logs/users" replace />} />
            <Route path="/platform/visitors" element={<Navigate to="/logs/visitors" replace />} />
            <Route path="/api-keys" element={<ApiKeysPage />} />
            {/* Org-master-key flows. Bootstrap shows the 24-word
                mnemonic ONCE; recovery-key accepts the mnemonic on a
                fresh device; recover-data is the owner / admin
                impersonation proof view. */}
            <Route
              path="/organization/recovery-key/bootstrap"
              element={<OrgKeyBootstrap />}
            />
            <Route
              path="/organization/recovery-key"
              element={<OrgRecoveryKey />}
            />
            <Route
              path="/organization/members/:uid/impersonate"
              element={<RecoverMemberData />}
            />
            {/* Legacy alias — "recover-data" read like the member lost data;
                "impersonate" describes what the owner is actually doing. */}
            <Route
              path="/organization/members/:uid/recover-data"
              element={
                <Navigate
                  to={
                    typeof window !== "undefined"
                      ? window.location.pathname.replace(
                          /\/recover-data$/,
                          "/impersonate",
                        ) + window.location.search
                      : "/organization/members"
                  }
                  replace
                />
              }
            />
            <Route
              path="/organization/audit/key-access"
              element={<OrgAuditLog />}
            />
            <Route path="/security/audit" element={<Navigate to="/logs/audit" replace />} />
            <Route path="/recover" element={<RecoverPage />} />
            <Route path="/settings/sso" element={<SsoSettings />} />
            <Route path="/settings/inboxes" element={<SharedInboxes />} />
            <Route path="/settings/webhooks" element={<Webhooks />} />
            <Route path="/settings/scim" element={<ScimTokens />} />
            <Route path="/settings/plans" element={<PlanAdmin />} />

          </Route>
        </Route>

        {/* FALLBACK */}
        <Route
          path="*"
          element={
            user ? (
              <Navigate to={accountHome} replace />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />

      </Routes>
    </Suspense>
  );
}
