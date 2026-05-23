import { Routes, Route, Navigate } from "react-router-dom";
import { useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";

import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
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
const PlatformAdminHome = lazy(() => import("./organization/PlatformAdminHome"));
const OrganizationHome = lazy(() => import("./organization/OrganizationHome"));
const EmailFiles = lazy(() => import("./files/EmailFiles"));
const ServicePage = lazy(() => import("./services/ServicePage"));
const Billing = lazy(() => import("./billing/Billing"));
const Pricing = lazy(() => import("./pricing/Pricing"));
const Enterprise = lazy(() => import("./marketing/Enterprise"));
const Support = lazy(() => import("./marketing/Support"));
const ApiKeysPage = lazy(() => import("./apikeys/ApiKeysPage"));
const SsoSettings = lazy(() => import("./settings/SsoSettings"));
const SharedInboxes = lazy(() => import("./settings/SharedInboxes"));
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
        <Route path="/services/:slug" element={<ServicePage />} />
        {/* Pricing is a public-facing page: anyone (logged out OR in) should
            be able to view plans. It lives here rather than under the
            ProtectedRoute branch so unauth visitors aren't bounced to
            /login. The component renders its own header chrome, so no
            Layout wrapper is needed. */}
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/enterprise" element={<Enterprise />} />
        <Route path="/support" element={<Support />} />

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
                accountType === "platform_admin" ? (
                  <PlatformAdminHome />
                ) : (
                  redirectToAccountHome ?? <PlatformAdminHome />
                )
              }
            />
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
            <Route path="/api-keys" element={<ApiKeysPage />} />
            <Route path="/security/audit" element={<AuditSecurity />} />
            <Route path="/recover" element={<RecoverPage />} />
            <Route path="/settings/sso" element={<SsoSettings />} />
            <Route path="/settings/inboxes" element={<SharedInboxes />} />

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
