// Owner / admin impersonation view with tabs for all 6 surfaces.
//
// On mount: recovers the target member's keypair via the org master key
// (impersonateMember → fetch member escrow → unwrap with org private
// key). The recovered key lives in a useState ref and is passed to each
// tab; closing the page wipes it. Never persisted to IndexedDB.
//
// Surfaces:
//   * Notes        — WAYVE_SECURE_V1 self-envelope, decrypt in-browser
//   * Emails       — WAYVE_SECURE_V1 single or multi-recipient envelope
//   * Chat         — direct messages + channel messages, WAYVE_CHAT_E2E_V1
//   * Drive        — list files (binary decryption deferred)
//   * Tasks        — plaintext (server-readable; not E2E in v1)
//   * Scheduler    — plaintext meetings (server-readable; not E2E in v1)

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { apiFetchJson } from "../api/client";
import { impersonateMember } from "./ownerImpersonate";

type Surface = "notes" | "emails" | "chat" | "drive" | "tasks" | "scheduler";

const TABS: Array<{ key: Surface; label: string; isE2E: boolean }> = [
  { key: "notes", label: "Notes", isE2E: true },
  { key: "emails", label: "Emails", isE2E: true },
  { key: "chat", label: "Chat", isE2E: true },
  { key: "drive", label: "Drive", isE2E: true },
  { key: "tasks", label: "Tasks", isE2E: false },
  { key: "scheduler", label: "Scheduler", isE2E: false },
];

// =====================================================================
//   Decryption helpers — use a SPECIFIC private key (impersonated)
//   rather than auto-loading from IndexedDB the way the regular
//   decrypt helpers do.
// =====================================================================

const td = new TextDecoder();

// Decrypt any WAYVE_SECURE_V1 envelope (notes self_v1, email single
// `wayve_encrypted`, email multi `wayve_encrypted_multi`) using the
// supplied private key + the target user_id (to look up the wrapped
// AES key slot in multi-recipient envelopes).
async function decryptWayveSecureV1(
  envelope: string,
  userId: number,
  privateKey: CryptoKey
): Promise<string> {
  if (!envelope.startsWith("WAYVE_SECURE_V1\n")) {
    return envelope; // not an envelope, return as-is
  }
  const body = JSON.parse(envelope.slice("WAYVE_SECURE_V1\n".length));
  let wrappedAes: number[];
  if (body.key) {
    // single-recipient
    wrappedAes = body.key as number[];
  } else if (body.keys) {
    const slot = body.keys[String(userId)];
    if (!slot) throw new Error(`no key slot for user ${userId}`);
    wrappedAes = slot as number[];
  } else {
    throw new Error("envelope has no key/keys field");
  }
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    new Uint8Array(wrappedAes).slice().buffer
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(body.iv).slice().buffer },
    aesKey,
    new Uint8Array(body.data).slice().buffer
  );
  return td.decode(plain);
}

// Decrypt a WAYVE_CHAT_E2E_V1 envelope using the supplied private key.
// Multi-recipient: looks up keys[userId] for the wrapped AES key slot.
async function decryptWayveChatE2E(
  envelope: string,
  userId: number,
  privateKey: CryptoKey
): Promise<string> {
  if (!envelope.startsWith("WAYVE_CHAT_E2E_V1\n")) {
    return envelope;
  }
  const body = JSON.parse(envelope.slice("WAYVE_CHAT_E2E_V1\n".length));
  const slot = body.keys?.[String(userId)];
  if (!slot) {
    throw new Error(`no chat key slot for user ${userId}`);
  }
  const aesRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    new Uint8Array(slot).slice().buffer
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(body.iv).slice().buffer },
    aesKey,
    new Uint8Array(body.data).slice().buffer
  );
  return td.decode(plain);
}

// =====================================================================
//   Row types
// =====================================================================

type Note = {
  id: number;
  title?: string | null;
  content?: string | null;
  updated_at?: string | null;
};
type Email = {
  id: number;
  subject?: string | null;
  sender?: string | null;
  receiver?: string | null;
  body_encrypted?: string | null;
  source?: string;
  created_at?: string | null;
};
type DirectMsg = {
  id: number;
  sender_id: number | null;
  receiver_id: number | null;
  // Storage-AES already removed server-side: this is the E2E envelope or
  // legacy plaintext.
  content: string | null;
  created_at?: string | null;
};
type ChannelMsg = {
  id: number;
  channel_id: number | null;
  channel_name: string | null;
  sender_id: number | null;
  content: string | null;
  created_at?: string | null;
};
type DriveFile = {
  id: number;
  name: string;
  file_type?: string | null;
  size?: number | null;
  updated_at?: string | null;
};
type Task = {
  id: number;
  name: string;
  description: string;
  priority: number;
  status: string;
  updated_at?: string | null;
};
type Meeting = {
  id: number;
  title: string;
  date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  zoom_join_url?: string | null;
};

// =====================================================================
//   Fingerprint of the recovered key (for the proof banner at the top)
// =====================================================================

async function fingerprintOfRecoveredKey(
  privateKey: CryptoKey
): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const pubKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: jwk.alg,
      ext: true,
      key_ops: ["encrypt"],
    },
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
  const spki = await crypto.subtle.exportKey("spki", pubKey);
  const hash = await crypto.subtle.digest("SHA-256", spki);
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

// =====================================================================
//   Page
// =====================================================================

type State =
  | { kind: "loading" }
  | { kind: "needs_key" }
  | {
      kind: "ok";
      memberKey: CryptoKey;
      fingerprint: string;
    }
  | { kind: "error"; message: string };

export default function RecoverMemberDataPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { uid } = useParams<{ uid: string }>();
  const memberUserId = uid ? Number(uid) : NaN;
  const orgId = user?.organization_id ?? null;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [activeTab, setActiveTab] = useState<Surface>("notes");

  useEffect(() => {
    if (!user || !orgId || !Number.isFinite(memberUserId)) {
      setState({ kind: "error", message: "Missing org or member id." });
      return;
    }
    let cancelled = false;
    impersonateMember(orgId, user.id, memberUserId)
      .then(async (ctx) => {
        if (cancelled) return;
        const fp = await fingerprintOfRecoveredKey(ctx.memberPrivateKey);
        setState({
          kind: "ok",
          memberKey: ctx.memberPrivateKey,
          fingerprint: fp,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Recovery failed.";
        if (message.toLowerCase().includes("not loaded")) {
          setState({ kind: "needs_key" });
        } else {
          setState({ kind: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, orgId, memberUserId]);

  return (
    <div style={{ padding: 40, maxWidth: 960 }}>
      <h2>Recover member data</h2>
      <p>
        Member <strong>{memberUserId}</strong> · Organization{" "}
        <strong>{orgId}</strong>
      </p>

      {state.kind === "loading" && (
        <p>Unwrapping member's escrow with org master key…</p>
      )}

      {state.kind === "needs_key" && (
        <>
          <p style={{ color: "#b91c1c" }}>
            Org master key not loaded on this device.
          </p>
          <button onClick={() => navigate("/organization/recovery-key")}>
            Enter recovery key
          </button>
        </>
      )}

      {state.kind === "error" && (
        <p style={{ color: "#b91c1c", whiteSpace: "pre-wrap" }}>
          {state.message}
        </p>
      )}

      {state.kind === "ok" && (
        <>
          <p style={{ color: "#059669", fontWeight: 600 }}>
            ✓ Recovered member key. Fingerprint: {state.fingerprint}
          </p>
          <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0 }}>
            Every read below is audit-logged. View the log at{" "}
            <a href="/organization/audit/key-access">
              /organization/audit/key-access
            </a>
            .
          </p>

          {/* Tab bar */}
          <div
            style={{
              display: "flex",
              gap: 4,
              marginTop: 24,
              borderBottom: "2px solid #e5e7eb",
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: "8px 16px",
                  border: "none",
                  borderBottom:
                    activeTab === tab.key
                      ? "3px solid #2563eb"
                      : "3px solid transparent",
                  background: "none",
                  cursor: "pointer",
                  fontWeight: activeTab === tab.key ? 600 : 400,
                  color: activeTab === tab.key ? "#2563eb" : "#374151",
                }}
              >
                {tab.label}
                {!tab.isE2E && (
                  <span
                    title="Plaintext on the server (not E2E in v1)"
                    style={{ marginLeft: 6, fontSize: 11, color: "#a16207" }}
                  >
                    plaintext
                  </span>
                )}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            {activeTab === "notes" && (
              <NotesTab
                orgId={orgId!}
                memberId={memberUserId}
                memberKey={state.memberKey}
              />
            )}
            {activeTab === "emails" && (
              <EmailsTab
                orgId={orgId!}
                memberId={memberUserId}
                memberKey={state.memberKey}
              />
            )}
            {activeTab === "chat" && (
              <ChatTab
                orgId={orgId!}
                memberId={memberUserId}
                memberKey={state.memberKey}
              />
            )}
            {activeTab === "drive" && (
              <DriveTab orgId={orgId!} memberId={memberUserId} />
            )}
            {activeTab === "tasks" && (
              <TasksTab orgId={orgId!} memberId={memberUserId} />
            )}
            {activeTab === "scheduler" && (
              <SchedulerTab orgId={orgId!} memberId={memberUserId} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================
//   Tab components
// =====================================================================

type DecryptProps = { orgId: number; memberId: number; memberKey: CryptoKey };
type PlainProps = { orgId: number; memberId: number };

function useTabFetch<T>(url: string): {
  data: T[] | null;
  error: string | null;
} {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetchJson<T[]>(url)
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Fetch failed.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { data, error };
}

function NotesTab({ orgId, memberId, memberKey }: DecryptProps) {
  const { data, error } = useTabFetch<Note>(
    `/api/organizations/${orgId}/members/${memberId}/notes`
  );
  const [decrypted, setDecrypted] = useState<
    Map<number, { title: string; content: string; error?: string }>
  >(new Map());

  useEffect(() => {
    if (!data) return;
    void (async () => {
      const m = new Map<
        number,
        { title: string; content: string; error?: string }
      >();
      for (const note of data) {
        try {
          const title = note.title
            ? await decryptWayveSecureV1(note.title, memberId, memberKey)
            : "(no title)";
          const content = note.content
            ? await decryptWayveSecureV1(note.content, memberId, memberKey)
            : "(empty)";
          m.set(note.id, { title, content });
        } catch (e) {
          m.set(note.id, {
            title: "(undecryptable)",
            content: "(undecryptable)",
            error: e instanceof Error ? e.message : "decrypt failed",
          });
        }
      }
      setDecrypted(m);
    })();
  }, [data, memberId, memberKey]);

  if (error) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>Loading notes…</p>;
  if (data.length === 0) return <p style={{ color: "#6b7280" }}>No notes.</p>;

  return (
    <>
      <p style={{ color: "#6b7280" }}>{data.length} note(s)</p>
      {data.map((n) => {
        const d = decrypted.get(n.id);
        return (
          <Row key={n.id} id={n.id} updatedAt={n.updated_at}>
            <strong>{d?.title ?? "…"}</strong>
            <pre style={preStyle(!!d?.error)}>
              {d?.content ?? "decrypting…"}
            </pre>
            {d?.error && <small style={{ color: "#b91c1c" }}>{d.error}</small>}
          </Row>
        );
      })}
    </>
  );
}

function EmailsTab({ orgId, memberId, memberKey }: DecryptProps) {
  const { data, error } = useTabFetch<Email>(
    `/api/organizations/${orgId}/members/${memberId}/emails`
  );
  const [decrypted, setDecrypted] = useState<
    Map<number, { body: string; error?: string }>
  >(new Map());

  useEffect(() => {
    if (!data) return;
    void (async () => {
      const m = new Map<number, { body: string; error?: string }>();
      for (const email of data) {
        const raw = email.body_encrypted ?? "";
        if (!raw) {
          m.set(email.id, { body: "(no body)" });
          continue;
        }
        if (!raw.startsWith("WAYVE_SECURE_V1\n")) {
          // legacy server-AES rows: not decryptable client-side
          m.set(email.id, {
            body: "(legacy server-AES body — not client-decryptable)",
          });
          continue;
        }
        try {
          const body = await decryptWayveSecureV1(raw, memberId, memberKey);
          m.set(email.id, { body });
        } catch (e) {
          m.set(email.id, {
            body: "(undecryptable)",
            error: e instanceof Error ? e.message : "decrypt failed",
          });
        }
      }
      setDecrypted(m);
    })();
  }, [data, memberId, memberKey]);

  if (error) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>Loading emails…</p>;
  if (data.length === 0) return <p style={{ color: "#6b7280" }}>No emails.</p>;

  return (
    <>
      <p style={{ color: "#6b7280" }}>{data.length} email(s)</p>
      {data.map((e) => {
        const d = decrypted.get(e.id);
        return (
          <Row key={e.id} id={e.id} updatedAt={e.created_at}>
            <strong>{e.subject ?? "(no subject)"}</strong>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {e.sender ?? "?"} → {e.receiver ?? "?"} · {e.source ?? "imap"}
            </div>
            <pre style={preStyle(!!d?.error)}>{d?.body ?? "decrypting…"}</pre>
            {d?.error && <small style={{ color: "#b91c1c" }}>{d.error}</small>}
          </Row>
        );
      })}
    </>
  );
}

function ChatTab({ orgId, memberId, memberKey }: DecryptProps) {
  const direct = useTabFetch<DirectMsg>(
    `/api/organizations/${orgId}/members/${memberId}/messages`
  );
  const channel = useTabFetch<ChannelMsg>(
    `/api/organizations/${orgId}/members/${memberId}/channel-messages`
  );
  const [decrypted, setDecrypted] = useState<
    Map<string, { text: string; error?: string }>
  >(new Map());

  useEffect(() => {
    const tryDecrypt = async (
      raw: string | null
    ): Promise<{ text: string; error?: string }> => {
      if (!raw) return { text: "(empty)" };
      if (raw.startsWith("WAYVE_CHAT_E2E_V1\n")) {
        try {
          return { text: await decryptWayveChatE2E(raw, memberId, memberKey) };
        } catch (e) {
          return {
            text: "(undecryptable)",
            error: e instanceof Error ? e.message : "",
          };
        }
      }
      // Not an E2E envelope: legacy chat stored under server-AES only. The
      // backend already removed that layer, so `raw` is the plaintext.
      return { text: raw };
    };

    void (async () => {
      const m = new Map<string, { text: string; error?: string }>();
      for (const msg of direct.data ?? []) {
        m.set(`d-${msg.id}`, await tryDecrypt(msg.content));
      }
      for (const msg of channel.data ?? []) {
        m.set(`c-${msg.id}`, await tryDecrypt(msg.content));
      }
      setDecrypted(m);
    })();
  }, [direct.data, channel.data, memberId, memberKey]);

  return (
    <>
      <h3>Direct messages</h3>
      {direct.error && <p style={{ color: "#b91c1c" }}>{direct.error}</p>}
      {!direct.data && <p>Loading…</p>}
      {direct.data?.length === 0 && (
        <p style={{ color: "#6b7280" }}>No direct messages.</p>
      )}
      {direct.data?.map((m) => {
        const d = decrypted.get(`d-${m.id}`);
        return (
          <Row key={`d-${m.id}`} id={m.id} updatedAt={m.created_at}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              from {m.sender_id} → {m.receiver_id}
            </div>
            <pre style={preStyle(!!d?.error)}>{d?.text ?? "…"}</pre>
          </Row>
        );
      })}

      <h3 style={{ marginTop: 24 }}>Channel messages</h3>
      {channel.error && <p style={{ color: "#b91c1c" }}>{channel.error}</p>}
      {!channel.data && <p>Loading…</p>}
      {channel.data?.length === 0 && (
        <p style={{ color: "#6b7280" }}>No channel messages.</p>
      )}
      {channel.data?.map((m) => {
        const d = decrypted.get(`c-${m.id}`);
        return (
          <Row key={`c-${m.id}`} id={m.id} updatedAt={m.created_at}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              #{m.channel_name ?? m.channel_id} · from {m.sender_id}
            </div>
            <pre style={preStyle(!!d?.error)}>{d?.text ?? "…"}</pre>
          </Row>
        );
      })}
    </>
  );
}

function DriveTab({ orgId, memberId }: PlainProps) {
  const { data, error } = useTabFetch<DriveFile>(
    `/api/organizations/${orgId}/members/${memberId}/files`
  );

  if (error) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>Loading files…</p>;
  if (data.length === 0) return <p style={{ color: "#6b7280" }}>No files.</p>;

  return (
    <>
      <p style={{ color: "#6b7280" }}>
        {data.length} file(s). Names are plaintext in v1; downloading +
        decrypting the binary blob (WV1 envelope) is a follow-up — the recovered
        member key is the same one that wrapped each file's content key, so
        decryption is mechanically possible from here.
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={cellStyle}>Name</th>
            <th style={cellStyle}>Type</th>
            <th style={cellStyle}>Size</th>
            <th style={cellStyle}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {data.map((f) => (
            <tr key={f.id}>
              <td style={cellStyle}>{f.name}</td>
              <td style={cellStyle}>{f.file_type ?? "—"}</td>
              <td style={cellStyle}>{f.size ?? 0} B</td>
              <td style={cellStyle}>
                {f.updated_at ? new Date(f.updated_at).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TasksTab({ orgId, memberId }: PlainProps) {
  const { data, error } = useTabFetch<Task>(
    `/api/organizations/${orgId}/members/${memberId}/tasks`
  );

  if (error) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>Loading tasks…</p>;
  if (data.length === 0) return <p style={{ color: "#6b7280" }}>No tasks.</p>;

  return (
    <>
      <p style={{ color: "#a16207", fontSize: 13 }}>
        ⚠ Tasks are plaintext on the server (not E2E in v1).
      </p>
      {data.map((t) => (
        <Row key={t.id} id={t.id} updatedAt={t.updated_at}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong>{t.name}</strong>
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              p{t.priority} · {t.status}
            </span>
          </div>
          <pre style={preStyle(false)}>
            {t.description || "(no description)"}
          </pre>
        </Row>
      ))}
    </>
  );
}

function SchedulerTab({ orgId, memberId }: PlainProps) {
  const { data, error } = useTabFetch<Meeting>(
    `/api/organizations/${orgId}/members/${memberId}/meetings`
  );

  if (error) return <p style={{ color: "#b91c1c" }}>{error}</p>;
  if (!data) return <p>Loading meetings…</p>;
  if (data.length === 0)
    return <p style={{ color: "#6b7280" }}>No meetings.</p>;

  return (
    <>
      <p style={{ color: "#a16207", fontSize: 13 }}>
        ⚠ Meetings are plaintext on the server (not E2E in v1).
      </p>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={cellStyle}>Title</th>
            <th style={cellStyle}>Date</th>
            <th style={cellStyle}>Time</th>
            <th style={cellStyle}>Zoom</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.id}>
              <td style={cellStyle}>{m.title}</td>
              <td style={cellStyle}>{m.date ?? "—"}</td>
              <td style={cellStyle}>
                {m.start_time ?? "—"} – {m.end_time ?? "—"}
              </td>
              <td style={cellStyle}>
                {m.zoom_join_url ? (
                  <a href={m.zoom_join_url} target="_blank" rel="noopener">
                    join
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// =====================================================================
//   Shared layout bits
// =====================================================================

function Row({
  id,
  updatedAt,
  children,
}: {
  id: number;
  updatedAt?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        margin: "12px 0",
        padding: 12,
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <span />
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          #{id}
          {updatedAt ? ` · ${new Date(updatedAt).toLocaleString()}` : ""}
        </span>
      </div>
      {children}
    </div>
  );
}

function preStyle(error: boolean): React.CSSProperties {
  return {
    margin: "8px 0 0",
    fontFamily: "inherit",
    whiteSpace: "pre-wrap",
    color: error ? "#b91c1c" : "#111827",
  };
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  marginTop: 8,
  fontSize: 14,
};

const cellStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderBottom: "1px solid #e5e7eb",
  textAlign: "left",
};
