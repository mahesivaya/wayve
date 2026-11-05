import { Link, useParams } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import RepoAccessPanel from "../github/RepoAccessPanel";
import SettingsShell from "../profile/SettingsShell";
import { canManageRepoAccess } from "./repoAccessGate";
import "./repositorySettings.css";

// One repository's settings, reached from its row in Settings > Repositories.
export default function RepoSettingsPage() {
  const { user } = useAuth();
  const { owner = "", repo = "" } = useParams<{
    owner: string;
    repo: string;
  }>();

  return (
    <SettingsShell title={`${owner}/${repo}`}>
      <Link className="repo-settings-back" to="/settings/repositories">
        ← Repositories
      </Link>
      <section className="settings-card repo-settings-card">
        {canManageRepoAccess(user) ? (
          <RepoAccessPanel owner={owner} repo={repo} />
        ) : (
          <p className="repo-settings-hint">
            Only your organization&apos;s owner or an admin can change who has
            access to this repository.
          </p>
        )}
      </section>
    </SettingsShell>
  );
}
