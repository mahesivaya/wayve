import type { Task } from "../api/tasks";

// Deep-link badge for a task imported from GitLab. Reuses the Jira badge styling
// (generic pill) and prefixes "GL" so the origin is clear.
export function GitlabBadge({ task }: { task: Task }) {
  if (!task.gitlab_issue_iid) return null;
  const label = `GL #${task.gitlab_issue_iid}`;
  if (!task.gitlab_web_url) {
    return <span className="jira-badge">{label}</span>;
  }
  return (
    <a
      className="jira-badge jira-badge--link"
      href={task.gitlab_web_url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open GitLab issue #${task.gitlab_issue_iid}`}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}
