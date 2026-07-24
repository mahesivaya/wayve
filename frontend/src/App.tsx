import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

// <Navigate to="..."/> can't interpolate a dynamic `:slug` from the URL, so
// this wrapper reads the param and forwards to /docs/services/:slug.
function LegacyServiceRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/docs/services/${slug ?? ""}`} replace />;
}

import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import RouteErrorBoundary from "./components/RouteErrorBoundary";
import RequirePricingAccess from "./components/RequirePricingAccess";
import Register from "./auth/Register";
import RegisterBusiness from "./auth/RegisterBusiness";
import Login from "./auth/Login";
import ForgotPassword from "./auth/ForgotPassword";
import ResetPassword from "./auth/ResetPassword";
import VerifyEmail from "./auth/VerifyEmail";
import RecoverWithMnemonicPage from "./auth/RecoverWithMnemonic";
import { useAuth } from "./auth/useAuth";
import { homePathForUser, normalizeAccountType } from "./auth/accountHome";
import { canViewIntegrations } from "./auth/permissions";
import { SPLIT_APPS } from "./components/LayoutConfig";

// Every page below is lazy-loaded; Layout, Header and AuthContext are the eager
// ones. Home and GitHubRepo also appear in SPLIT_APPS but keep dedicated lazy
// consts here because their routes are guarded or redirecting and so are
// declared explicitly. The rest of the split-pane apps have their routes
// generated from SPLIT_APPS, which stays the single source of truth.
const Home = lazy(() => import("./home/Home"));
const Call = lazy(() => import("./call/Call"));
const Documents = lazy(() => import("./documents/DocumentsBox"));
const Skills = lazy(() => import("./skills/SkillsBox"));
const GitHubRepo = lazy(() => import("./github/GitHubRepo"));
const TeamPage = lazy(() => import("./teams/TeamPage"));
const DomainVerification = lazy(
  () => import("./orgDomains/DomainVerification")
);
const ComingSoon = lazy(() => import("./components/ComingSoon"));
const NotFound = lazy(() => import("./components/NotFound"));
const Reminders = lazy(() => import("./reminders/Reminders"));
const TicketDetail = lazy(() => import("./tickets/TicketDetail"));
const StoryDetail = lazy(() => import("./userstories/StoryDetail"));
const Profile = lazy(() => import("./profile/Profile"));
const Settings = lazy(() => import("./profile/Settings"));
const Integrations = lazy(() => import("./integrations/Integrations"));
const Appearance = lazy(() => import("./profile/Appearance"));
const FeatureAccessPage = lazy(
  () => import("./featureAccess/FeatureAccessPage")
);
const Organization = lazy(() => import("./organization/Organization"));
const OrganizationAdminHome = lazy(
  () => import("./organization/OrganizationAdminHome")
);
const OrganizationMembers = lazy(
  () => import("./organization/OrganizationMembers")
);
const OrganizationDomains = lazy(
  () => import("./organization/OrganizationDomains")
);
const PlatformAdminHome = lazy(
  () => import("./organization/PlatformAdminHome")
);
const PlatformOrganizations = lazy(
  () => import("./organization/PlatformOrganizations")
);
const PlatformUsers = lazy(() => import("./organization/PlatformUsers"));
const MemberDetail = lazy(() => import("./organization/MemberDetail"));
const PlatformEnterprises = lazy(
  () => import("./organization/PlatformEnterprises")
);
const PlatformMembers = lazy(() => import("./organization/PlatformMembers"));
const OrganizationHome = lazy(() => import("./organization/OrganizationHome"));
const EmailFiles = lazy(() => import("./files/EmailFiles"));
const ServicePage = lazy(() => import("./services/ServicePage"));
const Billing = lazy(() => import("./billing/Billing"));
const PlatformBilling = lazy(() => import("./platformBilling/PlatformBilling"));
const PlatformDeveloper = lazy(
  () => import("./platformTeam/PlatformDeveloper")
);
const PlatformSupport = lazy(() => import("./platformTeam/PlatformSupport"));
const PlatformAnalytics = lazy(
  () => import("./platformTeam/PlatformAnalytics")
);
const PlatformWelcome = lazy(() => import("./platformTeam/PlatformWelcome"));
const PlatformSecrets = lazy(() => import("./platformTeam/PlatformSecrets"));
const PlatformLogs = lazy(() => import("./platformTeam/PlatformLogs"));
const PlatformUserLogs = lazy(() => import("./platformTeam/PlatformUserLogs"));
const PlatformVisitors = lazy(() => import("./platformTeam/PlatformVisitors"));
const Pricing = lazy(() => import("./pricing/Pricing"));
const Support = lazy(() => import("./marketing/Support"));
const BookDemo = lazy(() => import("./marketing/BookDemo"));
const Developers = lazy(() => import("./marketing/Developers"));
const Quotas = lazy(() => import("./marketing/Quotas"));
const Docs = lazy(() => import("./marketing/Docs"));
const SwaggerDocs = lazy(() => import("./marketing/SwaggerDocs"));
const DocsIndex = lazy(() => import("./docs/DocsIndex"));
const ApiKeysPage = lazy(() => import("./apikeys/ApiKeysPage"));
const ProjectsPage = lazy(() => import("./projects/ProjectsPage"));
const ProjectDetail = lazy(() => import("./projects/ProjectDetail"));
const SsoSettings = lazy(() => import("./settings/SsoSettings"));
const SharedInboxes = lazy(() => import("./settings/SharedInboxes"));
const Webhooks = lazy(() => import("./settings/Webhooks"));
const ScimTokens = lazy(() => import("./settings/ScimTokens"));
const PlanAdmin = lazy(() => import("./settings/PlanAdmin"));
const AiSettings = lazy(() => import("./settings/AiSettings"));
const TaskStatuses = lazy(() => import("./settings/TaskStatuses"));
const AiUsageGovernance = lazy(() => import("./settings/AiUsageGovernance"));
const SecureMessageView = lazy(() => import("./emails/SecureMessageView"));
const AuditSecurity = lazy(() => import("./settings/AuditSecurity"));
const UserAudit = lazy(() => import("./settings/UserAudit"));
const RecoverPage = lazy(() => import("./recovery/RecoverPage"));
const OrgKeyBootstrap = lazy(() => import("./orgKeys/BootstrapPage"));
const OrgRecoveryKey = lazy(() => import("./orgKeys/RecoveryKeyPage"));
const RecoverMemberData = lazy(() => import("./orgKeys/RecoverMemberDataPage"));
const OrgAuditLog = lazy(() => import("./orgKeys/AuditLogPage"));
const TestAccess = lazy(() => import("./test_access/TestAccess"));
const AccessRequestsReview = lazy(
  () => import("./accessRequests/AccessRequestsReview")
);
const TracingDashboard = lazy(() => import("./tracing/TracingDashboard"));

export default function App() {
  const { user } = useAuth();
  const location = useLocation();

  const accountHome = homePathForUser(user).toLowerCase();

  const accountType = normalizeAccountType(user?.account_type);
  // A switchable owner only reaches admin surfaces in admin mode. The
  // account_type-keyed guards below can't detect the downscoped /me on their
  // own (account_type is never mutated), so they must be ANDed with this.
  const adminMode = user?.mode === "admin";
  const isOrganizationUser =
    (accountType === "organization_admin" ||
      accountType === "organization" ||
      user?.organization_id != null) &&
    (adminMode || !user?.can_switch_admin);

  const isAtAccountHome = location.pathname.toLowerCase() === accountHome;

  const redirectToAccountHome = isAtAccountHome ? null : (
    <Navigate to={accountHome} replace />
  );

  return (
    <RouteErrorBoundary>
      <Suspense
        fallback={
          <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
            Loading…
          </div>
        }
      >
        <Routes>
          <Route
            path="/"
            element={user ? (redirectToAccountHome ?? <Home />) : <Home />}
          />

          {/* Public routes. */}
          <Route
            path="/login"
            element={user ? (redirectToAccountHome ?? <Login />) : <Login />}
          />
          <Route
            path="/register"
            element={
              user ? (redirectToAccountHome ?? <Register />) : <Register />
            }
          />
          <Route
            path="/register-business"
            element={
              user ? (
                (redirectToAccountHome ?? <RegisterBusiness />)
              ) : (
                <RegisterBusiness />
              )
            }
          />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route
            path="/recover-with-mnemonic"
            element={<RecoverWithMnemonicPage />}
          />
          {/* The secure-send magic link is deliberately public: the recipient
            need not be a Wayve user, and the passphrase is what unlocks the
            message. The page fetches ciphertext from a no-auth route and
            decrypts entirely client-side. */}
          <Route path="/m/:token" element={<SecureMessageView />} />
          <Route path="/organization" element={<Organization />} />
          <Route path="/services/:slug" element={<LegacyServiceRedirect />} />
          <Route path="/docs/services/:slug" element={<ServicePage />} />
          {/* Pricing sits outside ProtectedRoute so logged-out visitors can view
            plans without being bounced to /login, and it renders its own header
            chrome so it needs no Layout. Personal accounts are redirected to
            Settings, where "Manage billing & upgrade" lives. */}
          <Route
            path="/pricing"
            element={
              <RequirePricingAccess>
                <Pricing />
              </RequirePricingAccess>
            }
          />
          <Route path="/support" element={<Support />} />
          <Route path="/book-demo" element={<BookDemo />} />
          {/* The whole /docs/* tree is public, so anyone can browse the API
            contract. Legacy paths (/developers, /developers/quotas,
            /services/:slug) redirect to their canonical /docs/* URL. */}
          <Route path="/docs" element={<DocsIndex />} />
          <Route path="/docs/api" element={<SwaggerDocs />} />
          <Route path="/docs/developers" element={<Developers />} />
          <Route path="/docs/quotas" element={<Quotas />} />
          {/* The markdown catalog matches anything else under /docs/*, so it
            must stay AFTER the static routes above or /docs/api and friends
            would be treated as slugs. */}
          <Route path="/docs/:slug" element={<Docs />} />
          <Route
            path="/developers"
            element={<Navigate to="/docs/developers" replace />}
          />
          <Route
            path="/developers/quotas"
            element={<Navigate to="/docs/quotas" replace />}
          />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              {/* Sidebar split-pane app routes are generated from the SPLIT_APPS
                registry in LayoutConfig.ts, so adding an app there adds both the
                sidebar entry and its route. Guarded or redirecting ones opt out
                via autoRoute:false and are declared explicitly below. */}
              {SPLIT_APPS.filter((app) => app.autoRoute !== false).map(
                (app) => (
                  <Route key={app.key} path={app.path} element={<app.Comp />} />
                )
              )}

              {/* A single ticket opens on its own page (Tickets board routes here
                  via config.detailPath) instead of the edit modal. */}
              <Route path="/tickets/:id" element={<TicketDetail />} />

              {/* A single user story opens on its own page (User Stories board
                  routes here via config.detailPath) when Edit is clicked; a name
                  click opens the in-page drawer instead. */}
              <Route path="/user-stories/:id" element={<StoryDetail />} />

              <Route path="/home" element={redirectToAccountHome ?? <Home />} />
              <Route
                path="/organization/home"
                element={
                  isOrganizationUser ? (
                    <OrganizationAdminHome />
                  ) : (
                    (redirectToAccountHome ?? <OrganizationAdminHome />)
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
                  // A platform user whose role-derived home is some other page
                  // (billing lands on /platform/billing) is bounced out, so
                  // /platform/home never becomes the landing surface for a role
                  // with no actionable panels on it.
                  accountType === "platform_admin" &&
                  accountHome === "/platform/home" ? (
                    <PlatformAdminHome />
                  ) : (
                    (redirectToAccountHome ?? <PlatformAdminHome />)
                  )
                }
              />
              {/* Legacy alias — bookmarks from before the rename. */}
              <Route
                path="/platform-admin-home"
                element={<Navigate to="/platform/home" replace />}
              />
              <Route
                path="/organization/members"
                element={<OrganizationMembers />}
              />
              <Route
                path="/organization/members/:id"
                element={<MemberDetail scope="organization" />}
              />
              <Route
                path="/organization/domains"
                element={<OrganizationDomains />}
              />
              <Route
                path="/organization/settings"
                element={<Navigate to="/settings" replace />}
              />
              <Route
                path="/organization/:slug"
                element={redirectToAccountHome ?? <OrganizationHome />}
              />
              <Route path="/emails/attachments" element={<EmailFiles />} />
              {/* Legacy alias. */}
              <Route
                path="/email-files"
                element={<Navigate to="/emails/attachments" replace />}
              />
              <Route path="/reminders" element={<Reminders />} />
              <Route path="/call" element={<Call />} />
              <Route path="/documents" element={<Documents />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/teams/:slug" element={<TeamPage />} />
              {/* Legacy alias (no hyphen — original spelling). */}
              <Route
                path="/aichat"
                element={<Navigate to="/ai-chat" replace />}
              />
              {/* Any authenticated user may reach the Code Repo viewer, since
                the backend proxy serves a single read-only repo. The guard only
                bounces unauthenticated visitors. */}
              <Route
                path="/github"
                element={
                  user ? <GitHubRepo /> : <Navigate to={accountHome} replace />
                }
              />
              {/* Per-project repo viewer. The bare /github above stays the
                platform team's single-repo dashboard. */}
              <Route
                path="/github/:projectId"
                element={
                  user ? <GitHubRepo /> : <Navigate to={accountHome} replace />
                }
              />
              {/* Platform-owner only. */}
              <Route
                path="/logs/tracing"
                element={
                  user?.scope === "platform" &&
                  user?.effective_role === "owner" ? (
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
              {/* Platform-owner only. */}
              <Route
                path="/platform/domains"
                element={
                  user?.scope === "platform" &&
                  user?.effective_role === "owner" ? (
                    <DomainVerification />
                  ) : (
                    <Navigate to={accountHome} replace />
                  )
                }
              />
              <Route
                path="/coming-soon"
                element={<ComingSoon feature="Domains" />}
              />
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
              {/* Integrations is for personal accounts, whose only route to
                connecting a Gmail mailbox it is, and for organization and
                platform owners. Other members are bounced home. The sidebar and
                Settings links gate on the same predicate. */}
              <Route
                path="/integrations"
                element={
                  canViewIntegrations(user) ? (
                    <Integrations />
                  ) : (
                    <Navigate to={accountHome} replace />
                  )
                }
              />
              {/* Theme customizer as a page, so the settings sidebar's
                Appearance entry navigates like My Profile / Integrations. */}
              <Route path="/appearance" element={<Appearance />} />
              {/* The owner-only feature access matrix self-guards. One component
                serves both scopes; the backend resolves the matrix from the
                caller's scope. */}
              <Route
                path="/organization/access"
                element={<FeatureAccessPage />}
              />
              <Route path="/platform/access" element={<FeatureAccessPage />} />
              <Route path="/billing" element={<Billing />} />
              <Route
                path="/platform/organizations"
                element={<PlatformOrganizations />}
              />
              <Route path="/platform/users" element={<PlatformUsers />} />
              <Route
                path="/platform/members/:id"
                element={<MemberDetail scope="platform" />}
              />
              <Route
                path="/platform/enterprise"
                element={<PlatformEnterprises />}
              />
              <Route path="/platform/members" element={<PlatformMembers />} />
              <Route path="/platform/billing" element={<PlatformBilling />} />
              <Route
                path="/platform/developer"
                element={<PlatformDeveloper />}
              />
              <Route path="/platform/support" element={<PlatformSupport />} />
              <Route
                path="/platform/analytics"
                element={<PlatformAnalytics />}
              />
              <Route path="/platform/welcome" element={<PlatformWelcome />} />
              <Route path="/platform/secrets" element={<PlatformSecrets />} />
              {/* All log and audit surfaces live under one /logs/* namespace;
                the older paths below redirect here. */}
              <Route
                path="/logs"
                element={<Navigate to="/logs/app" replace />}
              />
              <Route path="/logs/app" element={<PlatformLogs />} />
              <Route path="/logs/users" element={<PlatformUserLogs />} />
              <Route path="/logs/audit" element={<AuditSecurity />} />
              <Route path="/logs/user-audit" element={<UserAudit />} />
              <Route path="/logs/visitors" element={<PlatformVisitors />} />
              <Route
                path="/platform/logs"
                element={<Navigate to="/logs/app" replace />}
              />
              <Route
                path="/organization/logs"
                element={<Navigate to="/logs/app" replace />}
              />
              <Route
                path="/platform/user-logs"
                element={<Navigate to="/logs/users" replace />}
              />
              <Route
                path="/platform/visitors"
                element={<Navigate to="/logs/visitors" replace />}
              />
              <Route path="/api-keys" element={<ApiKeysPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route
                path="/projects/:owner/:repo"
                element={<ProjectDetail />}
              />
              {/* Org-master-key flows: bootstrap shows the 24-word mnemonic
                once, recovery-key accepts it on a fresh device, and impersonate
                is the owner/admin proof view. */}
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
              {/* Legacy alias. */}
              <Route
                path="/organization/members/:uid/recover-data"
                element={
                  <Navigate
                    to={
                      typeof window !== "undefined"
                        ? window.location.pathname.replace(
                            /\/recover-data$/,
                            "/impersonate"
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
              <Route
                path="/security/audit"
                element={<Navigate to="/logs/audit" replace />}
              />
              <Route path="/recover" element={<RecoverPage />} />
              <Route path="/settings/sso" element={<SsoSettings />} />
              <Route path="/settings/inboxes" element={<SharedInboxes />} />
              <Route path="/settings/webhooks" element={<Webhooks />} />
              <Route path="/settings/scim" element={<ScimTokens />} />
              <Route path="/settings/plans" element={<PlanAdmin />} />
              <Route path="/settings/ai" element={<AiSettings />} />
              {/* Readable by anyone in the scope — the page itself hides the
                  editing affordances without `task_statuses:manage`. */}
              <Route path="/settings/statuses" element={<TaskStatuses />} />
              <Route
                path="/settings/ai/usage"
                element={<AiUsageGovernance />}
              />
            </Route>
          </Route>

          {/* Explicit 404, also reported to /api/error-logs. */}
          <Route
            path="*"
            element={<NotFound homePath={user ? accountHome : "/login"} />}
          />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}
