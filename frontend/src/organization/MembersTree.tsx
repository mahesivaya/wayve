import { useMemo, useState } from "react";
import type { Member } from "../api/rbac";
import { ROLE_LABELS, normalizeRole, type Role } from "../auth/permissions";
import Modal from "../components/Modal";
import "./membersTree.css";

// Org-chart view of the members list. There is no manager/reports-to field in
// the data, so the hierarchy is DERIVED from role rank (owner at the top, then
// super-admins, admins, the functional roles, members, guests). Each tier is a
// row; clicking a node shows the person's name, role, and (derived) reporting
// person. Used by both the organization and platform members pages.

const RANK: Record<Role, number> = {
  owner: 0,
  super_admin: 1,
  admin: 2,
  security: 3,
  billing: 3,
  developer: 3,
  support: 3,
  member: 4,
  guest: 5,
};

const PALETTE = [
  "#d7b29c", "#7c9eb2", "#a8c686", "#c89bb0",
  "#8d8aaa", "#e0a36d", "#6d9eb8", "#b8857a",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const rankOf = (m: Member) => RANK[normalizeRole(m.role)] ?? 4;
const displayName = (m: Member) => m.username || m.email;
const initial = (m: Member) => (displayName(m).trim()[0] ?? "?").toUpperCase();
const roleText = (m: Member) => m.role_label || ROLE_LABELS[normalizeRole(m.role)];

export default function MembersTree({ members }: { members: Member[] }) {
  const [selected, setSelected] = useState<Member | null>(null);

  const { tiers, reportingOf } = useMemo(() => {
    const sorted = [...members].sort(
      (a, b) => rankOf(a) - rankOf(b) || a.email.localeCompare(b.email),
    );
    const ranks = [...new Set(sorted.map(rankOf))].sort((a, b) => a - b);
    const tiers = ranks.map((rank) => ({
      rank,
      people: sorted.filter((m) => rankOf(m) === rank),
    }));
    // The "lead" of a tier (first by email) is who that tier's members report
    // to from the tier above.
    const leadByRank = new Map<number, Member>();
    for (const t of tiers) leadByRank.set(t.rank, t.people[0]);

    const reportingOf = (m: Member): Member | null => {
      const above = ranks.filter((r) => r < rankOf(m));
      if (above.length === 0) return null; // top of the org
      return leadByRank.get(above[above.length - 1]) ?? null;
    };

    return { tiers, reportingOf };
  }, [members]);

  return (
    <div className="members-tree" role="tree" aria-label="Members hierarchy">
      {tiers.map((tier) => (
        <div className="members-tree-tier" key={tier.rank}>
          {tier.people.map((m) => (
            <button
              type="button"
              key={m.user_id}
              className="members-tree-node"
              onClick={() => setSelected(m)}
              aria-label={`Show details for ${displayName(m)}`}
            >
              <span
                className="members-tree-avatar"
                style={{ background: avatarColor(m.email) }}
                aria-hidden="true"
              >
                {initial(m)}
              </span>
              <span className="members-tree-name">{displayName(m)}</span>
              <span className="members-tree-role">{roleText(m)}</span>
            </button>
          ))}
        </div>
      ))}

      <Modal
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        title="Member details"
      >
        {selected &&
          (() => {
            const reportsTo = reportingOf(selected);
            return (
              <div className="members-tree-detail">
                <div className="members-tree-detail-head">
                  <span
                    className="members-tree-avatar members-tree-avatar--lg"
                    style={{ background: avatarColor(selected.email) }}
                    aria-hidden="true"
                  >
                    {initial(selected)}
                  </span>
                  <div className="members-tree-detail-id">
                    <strong>{displayName(selected)}</strong>
                    <span>{selected.email}</span>
                  </div>
                </div>

                <dl className="members-tree-detail-grid">
                  <dt>Name</dt>
                  <dd>{displayName(selected)}</dd>
                  <dt>Role</dt>
                  <dd>{roleText(selected)}</dd>
                  <dt>Reporting to</dt>
                  <dd>
                    {reportsTo
                      ? `${displayName(reportsTo)} · ${roleText(reportsTo)}`
                      : "— (top of organization)"}
                  </dd>
                </dl>

                <p className="members-tree-detail-note">
                  Hierarchy &amp; reporting are derived from roles (there is no
                  manager field yet).
                </p>
              </div>
            );
          })()}
      </Modal>
    </div>
  );
}
