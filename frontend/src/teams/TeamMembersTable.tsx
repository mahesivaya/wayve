import { useEffect, useRef, useState, type ReactNode } from "react";
import ContactAvatar from "../shared/ContactAvatar";
import {
  ListFilterIcon,
  MembersIcon,
  SearchIcon,
  SlidersIcon,
  TrashIcon,
} from "../icons";

export type Member = {
  id: number;
  name: string;
  role: string;
  email: string;
  joinedAt: string | null;
  teams: string[];
};

// "Jun 6", with the year once it's not this year. Blank for a missing date.
function formatJoined(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

// An icon button in the toolbar and the small menu it opens. Stays open while
// its options are changed; closes on Escape or a click outside.
function ToolbarMenu({
  label,
  icon,
  active = false,
  children,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="team-roster-tool" ref={rootRef}>
      <button
        type="button"
        className={`team-roster-tool-btn${active ? " is-active" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={open ? undefined : label}
        data-tooltip-align="right"
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </button>
      {open && (
        <div className="team-roster-menu" role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function TeamMembersTable({
  members,
  canManage,
  busy,
  onRemove,
}: {
  members: Member[];
  canManage: boolean;
  busy: boolean;
  onRemove: (member: Member) => void;
}) {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [descending, setDescending] = useState(false);
  const [showRole, setShowRole] = useState(true);
  const [showJoined, setShowJoined] = useState(true);
  const [showTeams, setShowTeams] = useState(true);

  const roles = [...new Set(members.map((m) => m.role))].sort((a, b) =>
    a.localeCompare(b)
  );
  const needle = query.trim().toLowerCase();
  const visible = members
    .filter(
      (m) =>
        (roleFilter === null || m.role === roleFilter) &&
        (!needle ||
          [m.name, m.email, m.role, ...m.teams].some((field) =>
            field.toLowerCase().includes(needle)
          ))
    )
    .sort((a, b) =>
      descending ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
    );
  const columnCount =
    1 +
    Number(showRole) +
    Number(showJoined) +
    Number(showTeams) +
    Number(canManage);

  return (
    <>
      <div className="team-roster-toolbar">
        <label className="team-roster-search">
          <SearchIcon size={16} aria-hidden="true" />
          <input
            type="search"
            placeholder="Find members..."
            aria-label="Find members"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ToolbarMenu
          label="Filter by role"
          icon={<ListFilterIcon size={16} aria-hidden="true" />}
          active={roleFilter !== null}
        >
          {[null, ...roles].map((role) => (
            <button
              key={role ?? "all"}
              type="button"
              role="menuitemradio"
              aria-checked={roleFilter === role}
              className="team-roster-menu-item"
              onClick={() => setRoleFilter(role)}
            >
              {role ?? "All roles"}
            </button>
          ))}
        </ToolbarMenu>
        <ToolbarMenu
          label="Display options"
          icon={<SlidersIcon size={16} aria-hidden="true" />}
          active={!showRole || !showJoined || !showTeams}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showRole}
            className="team-roster-menu-item"
            onClick={() => setShowRole((value) => !value)}
          >
            Role
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showJoined}
            className="team-roster-menu-item"
            onClick={() => setShowJoined((value) => !value)}
          >
            Joined
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showTeams}
            className="team-roster-menu-item"
            onClick={() => setShowTeams((value) => !value)}
          >
            Teams
          </button>
        </ToolbarMenu>
      </div>

      <table className="team-roster">
        <thead>
          <tr>
            <th scope="col" aria-sort={descending ? "descending" : "ascending"}>
              <button
                type="button"
                className="team-roster-sort"
                onClick={() => setDescending((value) => !value)}
              >
                Name <span aria-hidden="true">{descending ? "↑" : "↓"}</span>
              </button>
            </th>
            {showRole && (
              <th scope="col" className="team-roster-col">
                Role
              </th>
            )}
            {showJoined && (
              <th scope="col" className="team-roster-col team-roster-wide">
                Joined
              </th>
            )}
            {showTeams && (
              <th scope="col" className="team-roster-col team-roster-wide">
                Teams
              </th>
            )}
            {canManage && (
              <th
                scope="col"
                className="team-roster-col-action"
                aria-label="Actions"
              />
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="team-roster-person">
                  <ContactAvatar
                    label={m.name}
                    className="team-roster-avatar"
                  />
                  <div className="team-roster-identity">
                    <span className="team-roster-name">{m.name}</span>
                    {m.email && (
                      <a
                        className="team-roster-email"
                        href={`mailto:${m.email}`}
                      >
                        {m.email}
                      </a>
                    )}
                  </div>
                </div>
              </td>
              {showRole && (
                <td className="team-roster-muted">
                  {m.role.toLowerCase() === "admin" ? (
                    <span className="team-roster-admin">{m.role}</span>
                  ) : (
                    m.role
                  )}
                </td>
              )}
              {showJoined && (
                <td className="team-roster-muted team-roster-wide">
                  {formatJoined(m.joinedAt)}
                </td>
              )}
              {showTeams && (
                <td className="team-roster-muted team-roster-wide">
                  {m.teams.length > 0 && (
                    <span
                      className="team-roster-teams"
                      title={m.teams.join(", ")}
                    >
                      <MembersIcon size={16} aria-hidden="true" />
                      <span className="team-roster-team-names">
                        {m.teams.join(", ")}
                      </span>
                    </span>
                  )}
                </td>
              )}
              {canManage && (
                <td className="team-roster-col-action">
                  <button
                    type="button"
                    className="team-roster-remove"
                    onClick={() => onRemove(m)}
                    disabled={busy}
                    aria-label={`Delete ${m.name}`}
                    data-tooltip="Delete"
                    data-tooltip-align="right"
                  >
                    <TrashIcon size={16} aria-hidden="true" />
                  </button>
                </td>
              )}
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td className="team-roster-empty" colSpan={columnCount}>
                {members.length === 0 ? "No members yet." : "No members match."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
