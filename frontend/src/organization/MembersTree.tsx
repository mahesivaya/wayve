import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { Member } from "../api/rbac";
import { ROLE_LABELS, normalizeRole, type Role } from "../auth/permissions";
import "./membersTree.css";

// Org-chart view of the members list. There is no manager/reports-to field in
// the data, so the hierarchy is DERIVED from role rank (owner at the top, then
// super-admins, admins, the functional roles, members, guests). Each tier is a
// row; clicking a node opens that member's full detail page (`memberHref`).
// Used by both the organization and platform members pages.

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
  "#d7b29c",
  "#7c9eb2",
  "#a8c686",
  "#c89bb0",
  "#8d8aaa",
  "#e0a36d",
  "#6d9eb8",
  "#b8857a",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const rankOf = (m: Member) => RANK[normalizeRole(m.role)] ?? 4;
const displayName = (m: Member) => m.username || m.email;
const initial = (m: Member) => (displayName(m).trim()[0] ?? "?").toUpperCase();
const roleText = (m: Member) =>
  m.role_label || ROLE_LABELS[normalizeRole(m.role)];

export default function MembersTree({
  members,
  memberHref,
}: {
  members: Member[];
  /** Detail-page path for a member, routed by the caller's scope. */
  memberHref: (member: Member) => string;
}) {
  const tiers = useMemo(() => {
    const sorted = [...members].sort(
      (a, b) => rankOf(a) - rankOf(b) || a.email.localeCompare(b.email)
    );
    const ranks = [...new Set(sorted.map(rankOf))].sort((a, b) => a - b);
    return ranks.map((rank) => ({
      rank,
      people: sorted.filter((m) => rankOf(m) === rank),
    }));
  }, [members]);

  return (
    <div className="members-tree" role="tree" aria-label="Members hierarchy">
      {tiers.map((tier) => (
        <div className="members-tree-tier" key={tier.rank}>
          {tier.people.map((m) => (
            <Link
              key={m.user_id}
              to={memberHref(m)}
              className="members-tree-node"
              aria-label={`View details for ${displayName(m)}`}
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
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
