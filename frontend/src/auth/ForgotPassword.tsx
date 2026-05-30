import { Link } from "react-router-dom";
import "./login.css";

// Plan A: email-link password reset is retired. The 24-word recovery
// phrase is the only path back into an account whose password is
// forgotten. This page used to host an email-link request form; it's
// now an information screen that funnels every visitor to
// /recover-with-mnemonic. The route is kept so existing bookmarks and
// in-app links don't 404 — they just land on the right next step.
export default function ForgotPassword() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h2>Forgot password?</h2>
        <p className="subtitle">
          Wayve uses end-to-end encryption, so we can't email you a reset
          link — no one at Wayve can decrypt your account. Your 24-word
          recovery phrase is the only way to reset your password. If you
          don't have it, the account is unrecoverable.
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
