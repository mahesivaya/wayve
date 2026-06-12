import { useState } from "react";
import type { FormEvent } from "react";
import { registerBusiness } from "../api/Auth";
import { useAuth } from "../auth/useAuth";
import { homePathForAccount } from "../auth/accountHome";
import { useNavigate, Link } from "react-router-dom";
import PublicHeader from "../components/PublicHeader";
import "./login.css"; // reuse auth-card styles

// Direct business signup — creates the organization AND its owner account in one
// step (owner is minted as organization_admin), instead of making a personal
// account first and upgrading. No payment here; billing is added later.
export default function RegisterBusiness() {
  const [orgName, setOrgName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const data = await registerBusiness({
        organization_name: orgName,
        username,
        email,
        password,
        confirm_password: confirmPassword,
      });
      if (!data || !data.token) {
        throw new Error("No token returned from server");
      }
      const accountType = data.account_type ?? "organization_admin";
      // Fresh registration → AuthContext sets up the owner's E2E keypair +
      // recovery phrase, same as a personal signup.
      login(data.token, accountType, true, password);
      const target = homePathForAccount(accountType);
      void navigate(target.startsWith("/") ? target : `/${target}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Business signup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page login-page--framed">
      <PublicHeader showActions={false} />
      <div className="login-page-body">
        <form className="login-card" onSubmit={handleSubmit}>
          <h2>Create a business account</h2>
          <p className="subtitle">Set up your organization on Fluxze</p>

          <input
            type="text"
            placeholder="Business name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            type="email"
            placeholder="Work email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />

          <button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create business account"}
          </button>

          {error && <p className="error">{error}</p>}

          <p className="switch-auth">
            Want a personal account? <Link to="/register">Sign up</Link> ·
            Already have one? <Link to="/login">Login</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
