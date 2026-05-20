// Standalone /call page: a tenant-scoped directory of users with audio/video
// call buttons. Kept as a sibling to /chat (per the chat/call UI merge) so
// existing bookmarks keep working and `useCallSession` is the single
// signaling-state owner.
//
// The chat-integrated entry point lives in [Chat](../chat/Chat.tsx) — when
// a 1:1 conversation is selected, ChatHeader renders the same audio/video
// icons and they call into the same hook.

import { useEffect, useMemo, useState } from "react";
import { apiFetchJson } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import CallOverlays from "./CallOverlays";
import { useCallSession } from "./useCallSession";
import "./call.css";

const log = logger.scope("call");

type DirectoryUser = {
  id: number;
  email: string;
};

export default function Call() {
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const session = useCallSession(myId, user?.email);
  const { callState, connected, startCall } = session;

  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetchJson<DirectoryUser[]>("/api/users/all")
      .then((rows) => {
        if (cancelled) return;
        setUsers(rows.filter((u) => u.id !== myId));
      })
      .catch((err) => {
        if (cancelled) return;
        log.error("user directory load failed", err);
        setUsersError("Failed to load users");
      });
    return () => {
      cancelled = true;
    };
  }, [myId]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, search]);

  return (
    <div className="call-page">
      <header className="call-page-header">
        <h2>Calls</h2>
        <span className={`call-conn ${connected ? "ok" : "down"}`}>
          {connected ? "Connected" : "Offline"}
        </span>
      </header>

      <CallOverlays session={session} />

      {callState.kind !== "active" && (
        <div className="call-directory">
          <input
            type="search"
            className="call-search"
            placeholder="Search by email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {usersError && <p className="call-error">{usersError}</p>}

          {!usersError && filteredUsers.length === 0 && (
            <p className="call-empty">No users to call.</p>
          )}

          <ul className="call-user-list">
            {filteredUsers.map((u) => {
              const disabled = callState.kind !== "idle" || !connected;
              return (
                <li key={u.id} className="call-user-row">
                  <div className="call-user-identity">
                    <div className="call-user-avatar" aria-hidden>
                      {u.email.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="call-user-email">{u.email}</span>
                  </div>
                  <div className="call-user-actions">
                    <button
                      type="button"
                      className="call-btn call-btn-audio"
                      disabled={disabled}
                      onClick={() => startCall(u.id, u.email, "audio")}
                      aria-label={`Audio call ${u.email}`}
                    >
                      🔊 Audio
                    </button>
                    <button
                      type="button"
                      className="call-btn call-btn-video"
                      disabled={disabled}
                      onClick={() => startCall(u.id, u.email, "video")}
                      aria-label={`Video call ${u.email}`}
                    >
                      🎥 Video
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
