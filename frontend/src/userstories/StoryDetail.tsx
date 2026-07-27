import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Task, TaskPriority } from "../api/tasks";
import {
  getUserStories,
  updateUserStoryApi,
  deleteUserStoryApi,
} from "../api/userStories";
import { getTaskStatuses, type TaskStatusRow } from "../api/taskStatuses";
// Reuses the ticket detail-page styling so the full-page story editor matches
// the ticket one (same `.ticket-detail-*` classes). The board's drawer shows
// the compose form; this is the "Edit → full page" surface.
import "../tickets/ticketDetail.css";

const PRIORITIES: TaskPriority[] = [1, 2, 3, 4, 5];

// Full-page editable view of a single user story — the User Stories board's
// Edit button routes here (config.detailPath) while a name click opens the
// in-page drawer. Edits go through updateUserStoryApi, so behaviour matches the
// board.
export default function StoryDetail() {
  const { id } = useParams();
  const storyId = Number(id);
  const navigate = useNavigate();

  const [story, setStory] = useState<Task | null>(null);
  const [statuses, setStatuses] = useState<TaskStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(3);
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");

  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [list, sts] = await Promise.all([
        getUserStories(),
        getTaskStatuses(),
      ]);
      setStatuses(sts);
      const found = list.find((t) => t.id === storyId);
      if (!found) {
        setStory(null);
        setLoadError("Story not found.");
        return;
      }
      setStory(found);
      setName(found.name);
      setDescription(found.description);
      setPriority((found.priority as TaskPriority) ?? 3);
      setStatus(found.status);
      setAssignee(found.assignee ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load story.");
    } finally {
      setLoading(false);
    }
  }, [storyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!story) return;
    if (!name.trim()) {
      setStatusMsg("Name is required.");
      return;
    }
    setSaving(true);
    setStatusMsg("");
    try {
      const updated = await updateUserStoryApi(story.id, {
        name: name.trim(),
        description,
        priority,
        status,
        assigned_by: story.assigned_by,
        assignee,
        assignee_id: story.assignee_id ?? null,
        project_id: story.project_id ?? null,
      });
      setStory(updated);
      setStatusMsg("Saved.");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  // Save is gated on the form actually differing from the story it loaded, so
  // an untouched page can't post a no-op update. `setStory(updated)` on a
  // successful save re-baselines this, which disables the button again. Name is
  // compared trimmed because `save` trims it — trailing whitespace is not an
  // edit.
  const dirty =
    story !== null &&
    (name.trim() !== story.name ||
      description !== story.description ||
      priority !== ((story.priority as TaskPriority) ?? 3) ||
      status !== story.status ||
      assignee !== (story.assignee ?? ""));

  const remove = async () => {
    if (!story) return;
    if (!window.confirm(`Delete story "${story.name}"? This can't be undone.`))
      return;
    try {
      await deleteUserStoryApi(story.id);
      navigate("/user-stories");
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  return (
    <div className="ticket-detail">
      <button
        type="button"
        className="ticket-detail-back"
        onClick={() => navigate("/user-stories")}
      >
        ← Back to User Stories
      </button>

      {loading ? (
        <p className="ticket-detail-muted">Loading story…</p>
      ) : loadError ? (
        <div className="ticket-detail-error">
          <strong>{loadError}</strong>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : story ? (
        <>
          <div className="ticket-detail-head">
            {story.task_number != null && (
              <span className="ticket-detail-key">#{story.task_number}</span>
            )}
            <h1>{name || "Untitled story"}</h1>
          </div>

          <form
            className="ticket-detail-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              <span>Title</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Story title"
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
              />
            </label>
            <div className="ticket-detail-row">
              <label>
                <span>Priority</span>
                <select
                  value={priority}
                  onChange={(e) =>
                    setPriority(Number(e.target.value) as TaskPriority)
                  }
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      P{p}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Status</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {statuses.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Assignee</span>
                <input
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder="Unassigned"
                />
              </label>
            </div>

            <div className="ticket-detail-actions">
              <button
                type="submit"
                className="primary"
                disabled={saving || !dirty}
                title={dirty ? undefined : "No changes to save"}
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                className="ticket-detail-delete"
                onClick={() => void remove()}
              >
                Delete
              </button>
              {statusMsg && (
                <span className="ticket-detail-msg" role="status">
                  {statusMsg}
                </span>
              )}
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
