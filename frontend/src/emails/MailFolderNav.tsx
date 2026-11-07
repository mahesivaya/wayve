import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getEmailSidebar,
  type EmailSidebarData,
  type SidebarLabel,
} from "../api/email";
import { logger } from "../utils/logger";
import type { EmailFolder } from "./types";
import { buildLabelTree, labelFolder, type LabelNode } from "./labelTree";

// Gmail-style folder menu for the email sidebar: the main folders, a "More"
// section, and the mailboxes' own labels as a collapsible tree, each with a
// badge count from GET /api/emails/sidebar.

type IconName =
  | "inbox"
  | "star"
  | "clock"
  | "important"
  | "send"
  | "scheduled"
  | "draft"
  | "allmail"
  | "spam"
  | "updates"
  | "social"
  | "promotions"
  | "forums"
  | "archive"
  | "review"
  | "trash"
  | "attachment"
  | "label";

// 24×24 stroke icons, drawn in currentColor.
const ICONS: Record<IconName, string> = {
  inbox: "M4 4h16v16H4z M4 13h4l1.5 3h5L16 13h4",
  star: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  important: "M4 6h11l5 6-5 6H4l5-6z",
  send: "M3 20l18-8L3 4l3 8-3 8z M6 12h7",
  scheduled:
    "M3 18l12-6L3 6l2 6-2 6z M5 12h5 M18 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M18 15v2l1 1",
  draft: "M6 3h8l4 4v14H6z M14 3v4h4",
  allmail: "M3 7h14v11H3z M3 7l7 5 7-5 M7 4h14v11",
  spam: "M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z M12 7v6 M12 16.5v.5",
  updates: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5v.5",
  social:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14.5c2 .7 3.2 2.6 3.5 5.5",
  promotions: "M3 12V4h8l10 10-8 8L3 12z M7.5 7.5h.01",
  forums: "M3 4h12v9H8l-4 3V4z M18 8h3v11l-3-2.5h-7V13",
  archive: "M3 4h18v4H3z M5 8v12h14V8 M10 12h4",
  review:
    "M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6 7v10 M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M18 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M18 17V9a3 3 0 0 0-3-3h-4 M13 4l-2 2 2 2",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6",
  attachment:
    "M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7",
  label: "M3 6h12l6 6-6 6H3z",
};

function Icon({ name, color }: { name: IconName; color?: string | null }) {
  return (
    <svg
      className="mail-nav-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill={name === "label" && color ? color : "none"}
      stroke={name === "label" && color ? color : "currentColor"}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

type FolderItem = { folder: EmailFolder; label: string; icon: IconName };

const MAIN_FOLDERS: ReadonlyArray<FolderItem> = [
  { folder: "inbox", label: "Inbox", icon: "inbox" },
  { folder: "starred", label: "Starred", icon: "star" },
  { folder: "snoozed", label: "Snoozed", icon: "clock" },
  { folder: "important", label: "Important", icon: "important" },
  { folder: "sent", label: "Sent", icon: "send" },
  { folder: "scheduled", label: "Scheduled", icon: "scheduled" },
  { folder: "drafts", label: "Drafts", icon: "draft" },
  { folder: "all", label: "All Mail", icon: "allmail" },
  { folder: "spam", label: "Spam", icon: "spam" },
  { folder: "social", label: "Social", icon: "social" },
  { folder: "updates", label: "Updates", icon: "updates" },
  { folder: "forums", label: "Forums", icon: "forums" },
  { folder: "promotions", label: "Promotions", icon: "promotions" },
];

const MORE_FOLDERS: ReadonlyArray<FolderItem> = [
  { folder: "archived", label: "Archived", icon: "archive" },
  { folder: "github", label: "Reviews", icon: "review" },
  { folder: "trash", label: "Trash", icon: "trash" },
];

const COLLAPSED_KEY = "rwayve.mailNav.collapsed";
const MORE_KEY = "rwayve.mailNav.moreOpen";
const REFRESH_MS = 60_000;

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function readMoreOpen(): boolean {
  try {
    return localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
}

function Badge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return <span className="mail-nav-count">{count.toLocaleString()}</span>;
}

export default function MailFolderNav({
  activeFolder,
  onSelectFolder,
  onShowAttachments,
  filesActive = false,
  accountId,
}: {
  activeFolder: EmailFolder | null;
  onSelectFolder: (folder: EmailFolder) => void;
  onShowAttachments?: () => void;
  filesActive?: boolean;
  // Scope the badges and labels to one account; null/undefined = all.
  accountId?: number | null;
}) {
  const [data, setData] = useState<EmailSidebarData | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [moreOpen, setMoreOpen] = useState<boolean>(readMoreOpen);

  const active = filesActive ? null : activeFolder;
  // "More" opens by itself while one of its folders is the current one.
  const moreShown =
    moreOpen ||
    filesActive ||
    MORE_FOLDERS.some((f) => f.folder === activeFolder);

  const refresh = useCallback(async () => {
    try {
      setData(await getEmailSidebar(accountId));
    } catch (err) {
      logger.warn("email sidebar load failed", err);
    }
  }, [accountId]);

  // Badges follow the account filter and the folder in view (opening mail
  // marks it read), plus a slow poll and a refresh when the tab regains focus.
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, activeFolder]);

  const toggleNode = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* per-browser convenience only */
      }
      return next;
    });
  };

  const toggleMore = () => {
    setMoreOpen((open) => {
      try {
        localStorage.setItem(MORE_KEY, open ? "0" : "1");
      } catch {
        /* per-browser convenience only */
      }
      return !open;
    });
  };

  // One tree per account; the account heading shows only with several.
  const accounts = useMemo(() => {
    const byAccount = new Map<
      number,
      { email: string; labels: SidebarLabel[] }
    >();
    for (const label of data?.labels ?? []) {
      const entry = byAccount.get(label.account_id) ?? {
        email: label.account_email,
        labels: [],
      };
      entry.labels.push(label);
      byAccount.set(label.account_id, entry);
    }
    return [...byAccount.entries()].map(([id, { email, labels }]) => ({
      id,
      email,
      tree: buildLabelTree(labels),
    }));
  }, [data]);

  const counts = data?.counts ?? {};

  const folderRow = ({ folder, label, icon }: FolderItem) => {
    const count = counts[folder];
    return (
      <li key={folder}>
        <button
          type="button"
          className={`mail-nav-item${active === folder ? " is-active" : ""}${count ? " has-unread" : ""}`}
          aria-current={active === folder ? "page" : undefined}
          onClick={() => onSelectFolder(folder)}
        >
          <Icon name={icon} />
          <span className="mail-nav-label">{label}</span>
          <Badge count={count} />
        </button>
      </li>
    );
  };

  const labelRows = (nodes: LabelNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      const folder = node.label ? labelFolder(node.label) : null;
      const isCollapsed = collapsed.has(node.key);
      const hasChildren = node.children.length > 0;
      const unread = node.label?.unread ?? 0;
      return (
        <li key={node.key}>
          <div
            className="mail-nav-label-row"
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="mail-nav-caret"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.segment}`}
                onClick={() => toggleNode(node.key)}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="mail-nav-caret-spacer" aria-hidden="true" />
            )}
            <button
              type="button"
              className={`mail-nav-item${folder && active === folder ? " is-active" : ""}${unread ? " has-unread" : ""}`}
              aria-current={folder && active === folder ? "page" : undefined}
              disabled={!folder}
              onClick={() => folder && onSelectFolder(folder)}
              data-tooltip={node.label?.name}
            >
              <Icon name="label" color={node.label?.color} />
              <span className="mail-nav-label">{node.segment}</span>
              <Badge count={unread} />
            </button>
          </div>
          {hasChildren && !isCollapsed && (
            <ul className="mail-nav-list">
              {labelRows(node.children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <nav className="mail-nav" aria-label="Mail folders">
      <ul className="mail-nav-list">
        {MAIN_FOLDERS.map(folderRow)}
        <li>
          <button
            type="button"
            className="mail-nav-item mail-nav-more"
            aria-expanded={moreShown}
            onClick={toggleMore}
          >
            <span
              className="mail-nav-icon mail-nav-more-caret"
              aria-hidden="true"
            >
              {moreShown ? "▴" : "▾"}
            </span>
            <span className="mail-nav-label">
              {moreShown ? "Less" : "More"}
            </span>
          </button>
        </li>
        {moreShown && (
          <>
            {MORE_FOLDERS.map(folderRow)}
            {onShowAttachments && (
              <li>
                <button
                  type="button"
                  className={`mail-nav-item${filesActive ? " is-active" : ""}`}
                  aria-current={filesActive ? "page" : undefined}
                  onClick={onShowAttachments}
                >
                  <Icon name="attachment" />
                  <span className="mail-nav-label">Attachments</span>
                </button>
              </li>
            )}
          </>
        )}
      </ul>

      {accounts.length > 0 && (
        <div className="mail-nav-labels">
          <div className="mail-nav-heading">Labels</div>
          {accounts.map((account) => (
            <div key={account.id}>
              {accounts.length > 1 && (
                <div className="mail-nav-account" title={account.email}>
                  {account.email}
                </div>
              )}
              <ul className="mail-nav-list">{labelRows(account.tree, 0)}</ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
