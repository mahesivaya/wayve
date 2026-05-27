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
import RedirectIfPersonal from "./components/RedirectIfPersonal";
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
const About = lazy(() => import("./about/About"));
const Profile = lazy(() => import("./profile/Profile"));
const Settings = lazy(() => import("./profile/Settings"));
const Organization = lazy(() => import("./organization/Organization"));
const OrganizationAdminHome = lazy(() => import("./organization/OrganizationAdminHome"));
const OrganizationMembers = lazy(() => import("./organization/OrganizationMembers"));
const PlatformAdminHome = lazy(() => import("./organization/PlatformAdminHome"));
const PlatformOrganizations = lazy(() => import("./organization/PlatformOrganizations"));
const PlatformMembers = lazy(() => import("./organization/PlatformMembers"));
const OrganizationHome = lazy(() => import("./organization/OrganizationHome"));
const EmailFiles = lazy(() => import("./files/EmailFiles"));
const ServicePage = lazy(() => import("./services/ServicePage"));
const Billing = lazy(() => import("./billing/Billing"));
const CreateOrganization = lazy(() => import("./organization/CreateOrganization"));
const PlatformBilling = lazy(() => import("./platformBilling/PlatformBilling"));
const PlatformDeveloper = lazy(() => import("./platformTeam/PlatformDeveloper"));
const PlatformSupport = lazy(() => import("./platformTeam/PlatformSupport"));
const PlatformWelcome = lazy(() => import("./platformTeam/PlatformWelcome"));
const PlatformSecrets = lazy(() => import("./platformTeam/PlatformSecrets"));
const Pricing = lazy(() => import("./pricing/Pricing"));
const Enterprise = lazy(() => import("./marketing/Enterprise"));
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
const AuditSecurity = lazy(() => import("./settings/AuditSecurity"));
const RecoverPage = lazy(() => import("./recovery/RecoverPage"));

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
    <Suspense fallback={<div>Loading...</div>}>
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
            <RedirectIfPersonal to="/settings">
              <Pricing />
            </RedirectIfPersonal>
          }
        />
        <Route path="/enterprise" element={<Enterprise />} />
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
              path="/organization-home"
              element={
                isOrganizationUser ? (
                  <OrganizationAdminHome />
                ) : (
                  redirectToAccountHome ?? <OrganizationAdminHome />
                )
              }
            />
            <Route
              path="/platform-admin-home"
              element={
                // A platform user whose role-derived home is NOT this page
                // (currently: billing → /platform/billing) gets bounced out.
                // Keeps /platform-admin-home from being the landing surface
                // for roles that have no actionable panels on it.
                accountType === "platform_admin" &&
                accountHome === "/platform-admin-home" ? (
                  <PlatformAdminHome />
                ) : (
                  redirectToAccountHome ?? <PlatformAdminHome />
                )
              }
            />
            <Route path="/organization/members" element={<OrganizationMembers />} />
            <Route
              path="/organization/:slug"
              element={redirectToAccountHome ?? <OrganizationHome />}
            />
            <Route path="/emails" element={<Emails />} />
            <Route path="/email-files" element={<EmailFiles />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/call" element={<Call />} />
            <Route path="/scheduler" element={<Scheduler />} />
            <Route path="/drive" element={<Drive />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/aichat" element={<AIChat />} />
            <Route path="/about" element={<About />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/organizations/new" element={<CreateOrganization />} />
            <Route path="/platform/organizations" element={<PlatformOrganizations />} />
            <Route path="/platform/members" element={<PlatformMembers />} />
            <Route path="/platform/billing" element={<PlatformBilling />} />
            <Route path="/platform/developer" element={<PlatformDeveloper />} />
            <Route path="/platform/support" element={<PlatformSupport />} />
            <Route path="/platform/welcome" element={<PlatformWelcome />} />
            <Route path="/platform/secrets" element={<PlatformSecrets />} />
            <Route path="/api-keys" element={<ApiKeysPage />} />
            <Route path="/security/audit" element={<AuditSecurity />} />
            <Route path="/recover" element={<RecoverPage />} />
            <Route path="/settings/sso" element={<SsoSettings />} />
            <Route path="/settings/inboxes" element={<SharedInboxes />} />
            <Route path="/settings/webhooks" element={<Webhooks />} />
            <Route path="/settings/scim" element={<ScimTokens />} />

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
