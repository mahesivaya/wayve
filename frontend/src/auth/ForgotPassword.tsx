import { Link } from "react-router-dom";
import "./login.css";
import { usePublicTheme } from "../theme/usePublicTheme";

// There is no email-link password reset: the 24-word recovery phrase is the only
// way back into an account. This page exists purely to funnel visitors to
// /recover-with-mnemonic, and the route is kept so old bookmarks don't 404.
export default function ForgotPassword() {
  const { mode: publicTheme } = usePublicTheme();
  return (
    <div className="login-page" data-public-theme={publicTheme}>
      <div className="login-card">
        <h2>Forgot password?</h2>
        <p className="subtitle">
          Fluxze uses end-to-end encryption, so we can't email you a reset link
          — no one at Fluxze can decrypt your account. Your 24-word recovery
          phrase is the only way to reset your password. If you don't have it,
          the account is unrecoverable.
        </p>

        <Link to="/recover-with-mnemonic" className="login-primary-link">
          <button type="button">Reset with recovery phrase</button>
        </Link>

        <p className="switch-auth">
          <Link to="/login">Back to login</Link>
        </p>
      </div>
    </div>
  );
}
