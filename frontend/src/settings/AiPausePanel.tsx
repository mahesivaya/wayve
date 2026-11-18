// The owner's switches for pausing AI. An organization's owner can pause the
// whole organization or single members; the platform owner can pause any
// organization. Self-fetching, like AiUsagePanel next to it; the backend
// decides which of the two views the caller gets.

import { useCallback, useEffect, useState } from "react";
import {
  getAiPause,
  setAiMemberPaused,
  setAiOrgPaused,
  setAiOrganizationPausedByPlatform,
  type AiPauseState,
} from "../api/aiProvider";

function Status({ paused, label }: { paused: boolean; label?: string }) {
  return (
    <span className={`ai-pause-status${paused ? " is-paused" : ""}`}>
      {label ?? (paused ? "Paused" : "Active")}
    </span>
  );
}

function Toggle({
  paused,
  busy,
  onToggle,
  what,
}: {
  paused: boolean;
  busy: boolean;
  onToggle: () => void;
  // Who the button acts on, for its accessible name.
  what: string;
}) {
  return (
    <button
      type="button"
      className={`ai-pause-btn${paused ? "" : " is-danger"}`}
      onClick={onToggle}
      disabled={busy}
      aria-label={`${paused ? "Resume" : "Pause"} AI for ${what}`}
    >
      {paused ? "Resume" : "Pause"}
    </button>
  );
}

export default function AiPausePanel() {
  const [state, setState] = useState<AiPauseState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // What is being saved: "org", `m<user id>` or `o<organization id>`.
  const [saving, setSaving] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async (query: string) => {
    try {
      setState(await getAiPause(query));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount, and again a moment after the platform owner stops typing.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(search), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const save = async (key: string, request: () => Promise<unknown>) => {
    setSaving(key);
    setError("");
    try {
      await request();
      await load(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <p>Loading…</p>;
  if (!state) return <p className="ai-error">{error}</p>;

  if (state.scope === "platform") {
    return (
      <section className="ai-card">
        <input
          className="ai-pause-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search organizations"
          aria-label="Search organizations"
        />
        {error && <p className="ai-error">{error}</p>}
        <table className="ai-table ai-pause-table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Members</th>
              <th>AI</th>
              <th aria-label="Action" />
            </tr>
          </thead>
          <tbody>
            {state.organizations.length ? (
              state.organizations.map((o) => (
                <tr key={o.id}>
                  <td>{o.name}</td>
                  <td>{o.members.toLocaleString()}</td>
                  <td>
                    <Status
                      paused={o.paused || o.paused_by_owner}
                      label={
                        o.paused
                          ? "Paused by platform"
                          : o.paused_by_owner
                            ? "Paused by its owner"
                            : undefined
                      }
                    />
                  </td>
                  <td>
                    <Toggle
                      paused={o.paused}
                      busy={saving !== null}
                      what={o.name}
                      onToggle={() =>
                        void save(`o${o.id}`, () =>
                          setAiOrganizationPausedByPlatform(o.id, !o.paused)
                        )
                      }
                    />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>
                  {search
                    ? "No organization matches."
                    : "No organizations yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {state.organizations.length >= state.limit && (
          <p className="ai-pause-note">
            Showing the first {state.limit}. Search to find others.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="ai-card">
      {state.paused_by_platform && (
        <p className="ai-pause-banner">
          The platform has paused AI for this organization. Nobody here can use
          it until the platform switches it back on; the switches below take
          effect after that.
        </p>
      )}
      {error && <p className="ai-error">{error}</p>}
      <div className="ai-pause-org">
        <div>
          <strong>Whole organization</strong>
          <p>
            {state.paused
              ? "AI is paused for everyone in the organization, including you."
              : "Everyone can use AI, except the members paused below."}
          </p>
        </div>
        <Status paused={state.paused} />
        <Toggle
          paused={state.paused}
          busy={saving !== null}
          what="the whole organization"
          onToggle={() => void save("org", () => setAiOrgPaused(!state.paused))}
        />
      </div>
      <table className="ai-table ai-pause-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>AI</th>
            <th aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {state.members.map((m) => (
            <tr key={m.user_id}>
              <td>
                {m.username}
                {m.name && m.name !== m.username && (
                  <span className="ai-member-name"> · {m.name}</span>
                )}
              </td>
              <td>
                <Status paused={m.paused} />
              </td>
              <td>
                <Toggle
                  paused={m.paused}
                  busy={saving !== null}
                  what={m.username}
                  onToggle={() =>
                    void save(`m${m.user_id}`, () =>
                      setAiMemberPaused(m.user_id, !m.paused)
                    )
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
