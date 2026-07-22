import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../utils/logger";
import { sendAiChat } from "../api/ai";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { useGlobalSearch } from "../search/SearchContext";
import { formatFileSize } from "../emails/renderUtils";
import Modal from "../components/Modal";
import {
  listSkillFolders,
  createSkillFolder,
  renameSkillFolder,
  deleteSkillFolder,
  listSkillFiles,
  uploadSkillFiles,
  renameSkillFile,
  deleteSkillFile,
  downloadSkillFile,
  createTextSkill,
  getSkillContent,
  updateSkillContent,
  listSkillCatalog,
  type DocumentFolder,
  type DocumentFile,
  type SkillCatalogEntry,
} from "../api/skills";
import "../drive/drive.css";

// The Skills page is the shared workspace's second file tree (see Documents /
// DocumentsBox — same UI, distinct "skills" collection on the backend). It adds
// a read-only "Claude Skills" section listing the repository's built-in agent
// skills above the uploadable/creatable files.

type Crumb = { id: number | null; name: string };
const ROOT_CRUMB: Crumb = { id: null, name: "Skills" };

type Editing = { kind: "file" | "folder"; id: number } | null;

const TEXT_TYPES = [
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "log",
  "yml",
  "yaml",
  "html",
  "css",
  "js",
  "ts",
  "xml",
  "rtf",
  "text",
];
const isTextFile = (t: string | null): boolean =>
  TEXT_TYPES.includes((t ?? "").toLowerCase());

const MAX_AI_CHARS = 100_000;

const GRAMMAR_PROMPT = (content: string): string =>
  "You are a copy editor. Correct the spelling and grammar of the text between " +
  "<text> tags. Preserve the original meaning, tone, and line breaks. Return ONLY " +
  "the corrected text — no preamble, quotes, or commentary.\n<text>\n" +
  content +
  "\n</text>";
const SUMMARY_PROMPT = (content: string): string =>
  "Summarize the text between <text> tags in plain, easy-to-understand language " +
  "for a non-expert. Use a few short sentences or bullet points. Return ONLY the " +
  "summary.\n<text>\n" +
  content +
  "\n</text>";

function iconFor(fileType: string | null): string {
  const t = (fileType ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(t))
    return "🖼️";
  if (t === "pdf") return "📕";
  if (["doc", "docx", "txt", "md", "rtf"].includes(t)) return "📝";
  if (["xls", "xlsx", "csv"].includes(t)) return "📊";
  if (["zip", "rar", "7z", "tar", "gz"].includes(t)) return "🗜️";
  return "📄";
}

export default function SkillsBox() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "documents:manage");
  const { normalizedSearchQuery } = useGlobalSearch();

  const [path, setPath] = useState<Crumb[]>([ROOT_CRUMB]);
  const currentFolderId = path[path.length - 1]?.id ?? null;

  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [editDraft, setEditDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read-only viewer for a built-in Claude skill.
  const [catalogView, setCatalogView] = useState<SkillCatalogEntry | null>(
    null
  );

  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFileBody, setNewFileBody] = useState("");
  const [savingNewFile, setSavingNewFile] = useState(false);

  const [editorFile, setEditorFile] = useState<DocumentFile | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [aiBusy, setAiBusy] = useState<"fix" | "summary" | null>(null);
  const [grammarSuggestion, setGrammarSuggestion] = useState<string | null>(
    null
  );
  const [summary, setSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    try {
      const [f, d, c] = await Promise.all([
        listSkillFolders(currentFolderId),
        listSkillFiles(currentFolderId),
        // Catalog is repo-global, but only meaningful at the root; fetch once and
        // keep it — a cheap read that quietly yields [] if the skills aren't
        // present in this deployment.
        currentFolderId === null
          ? listSkillCatalog()
          : Promise.resolve(catalog),
      ]);
      setFolders(Array.isArray(f) ? f : []);
      setFiles(Array.isArray(d) ? d : []);
      setCatalog(Array.isArray(c) ? c : []);
    } catch (err) {
      logger.error("skills load failed", err);
      setError("Failed to load skills.");
    }
    // `catalog` is intentionally omitted: it's only read to carry the prior value
    // forward inside subfolders, and including it would refetch on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, currentFolderId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchAll(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const doUpload = async (incoming: File[]) => {
    if (incoming.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      await uploadSkillFiles(incoming, currentFolderId);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    setCreatingFolder(false);
    setNewFolderName("");
    if (!name) return;
    try {
      await createSkillFolder(name, currentFolderId);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const submitNewFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    setSavingNewFile(true);
    setError(null);
    try {
      await createTextSkill(name, newFileBody, currentFolderId);
      setCreatingFile(false);
      setNewFileName("");
      setNewFileBody("");
      await fetchAll();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create document"
      );
    } finally {
      setSavingNewFile(false);
    }
  };

  const openEditor = async (file: DocumentFile) => {
    setEditorFile(file);
    setEditorContent("");
    setEditorLoading(true);
    setError(null);
    setAiBusy(null);
    setGrammarSuggestion(null);
    setSummary(null);
    setAiError(null);
    setAttachOpen(false);
    try {
      const data = await getSkillContent(file.id);
      setEditorContent(data.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open document");
      setEditorFile(null);
    } finally {
      setEditorLoading(false);
    }
  };

  const saveEditor = async () => {
    if (!editorFile) return;
    setEditorSaving(true);
    setError(null);
    try {
      await updateSkillContent(editorFile.id, editorContent);
      setEditorFile(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save document");
    } finally {
      setEditorSaving(false);
    }
  };

  const aiDisabled =
    aiBusy !== null ||
    editorSaving ||
    editorContent.trim().length === 0 ||
    editorContent.length > MAX_AI_CHARS;

  const runAssist = async (
    kind: "fix" | "summary",
    build: (content: string) => string,
    onReply: (reply: string) => void
  ) => {
    if (aiDisabled) return;
    setAiBusy(kind);
    setAiError(null);
    try {
      const res = await sendAiChat([
        { role: "user", content: build(editorContent) },
      ]);
      const reply = (res.reply ?? "").trim();
      if (!reply) throw new Error("The assistant returned an empty result.");
      onReply(reply);
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : "Couldn't reach the assistant. It may not be set up for your workspace yet."
      );
    } finally {
      setAiBusy(null);
    }
  };

  const runGrammarFix = () =>
    void runAssist("fix", GRAMMAR_PROMPT, setGrammarSuggestion);
  const runSummary = () => void runAssist("summary", SUMMARY_PROMPT, setSummary);

  const applyGrammar = () => {
    if (grammarSuggestion === null) return;
    setEditorContent(grammarSuggestion);
    setGrammarSuggestion(null);
  };

  const copySummary = () => {
    if (summary === null) return;
    void navigator.clipboard?.writeText(summary).catch(() => undefined);
  };

  const insertFileReference = useCallback((file: DocumentFile) => {
    const ref = `[${file.name}](/api/skills/${file.id}/download)`;
    const el = editorTextareaRef.current;
    setEditorContent((cur) => {
      if (!el) return cur ? `${cur}\n${ref}` : ref;
      const start = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? start;
      const caret = start + ref.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
      return cur.slice(0, start) + ref + cur.slice(end);
    });
    setAttachOpen(false);
  }, []);

  const commitRename = async () => {
    const target = editing;
    const name = editDraft.trim();
    setEditing(null);
    setEditDraft("");
    if (!target || !name) return;
    try {
      if (target.kind === "folder") await renameSkillFolder(target.id, name);
      else await renameSkillFile(target.id, name);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  const removeFolder = async (id: number, name: string) => {
    if (!window.confirm(`Delete folder "${name}" and everything inside it?`))
      return;
    try {
      await deleteSkillFolder(id);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const removeFile = async (id: number, name: string) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
      await deleteSkillFile(id);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const q = normalizedSearchQuery.trim().toLowerCase();
  const shownFolders = q
    ? folders.filter((f) => f.name.toLowerCase().includes(q))
    : folders;
  const shownFiles = q
    ? files.filter((f) => f.name.toLowerCase().includes(q))
    : files;
  const shownCatalog = q
    ? catalog.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      )
    : catalog;
  const atRoot = currentFolderId === null;

  return (
    <div className="drive-container">
      {(path.length > 1 || canManage) && (
        <div className="drive-breadcrumb">
          {path.length > 1 &&
            path.map((crumb, idx) => (
              <span
                key={`${crumb.id ?? "root"}-${idx}`}
                className="drive-crumb"
              >
                {idx > 0 && <span className="drive-crumb-sep"> / </span>}
                <button
                  type="button"
                  className="drive-crumb-link"
                  onClick={() => setPath((prev) => prev.slice(0, idx + 1))}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          {canManage && (
            <div className="drive-breadcrumb-actions">
              {creatingFolder ? (
                <>
                  <input
                    className="drive-folder-input"
                    value={newFolderName}
                    autoFocus
                    placeholder="Folder name"
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitNewFolder();
                      else if (e.key === "Escape") {
                        setCreatingFolder(false);
                        setNewFolderName("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="drive-folder-create-btn"
                    onClick={() => void submitNewFolder()}
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    className="drive-folder-cancel-btn"
                    onClick={() => {
                      setCreatingFolder(false);
                      setNewFolderName("");
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="drive-folder-new-btn"
                    onClick={() => setCreatingFile(true)}
                  >
                    + New file
                  </button>
                  <button
                    type="button"
                    className="drive-folder-new-btn"
                    onClick={() => setCreatingFolder(true)}
                  >
                    + New folder
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="upload-section">
        <div className="drive-header">
          <h2>Skills</h2>
        </div>
        {canManage ? (
          <div
            className="drop-zone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void doUpload(Array.from(e.dataTransfer.files));
            }}
          >
            <p>{uploading ? "Uploading…" : "Drag & drop files here, or"}</p>
            <label className="browse-btn">
              Browse
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void doUpload(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        ) : (
          <p className="file-meta">
            You have read-only access to this workspace. Only owners and super
            admins can add or change files.
          </p>
        )}
        {error && <p className="drive-error-msg">{error}</p>}
      </div>

      {/* Built-in Claude skills — read-only, only at the root. */}
      {atRoot && shownCatalog.length > 0 && (
        <div className="files-section">
          <h3>Claude Skills</h3>
          <div className="file-list">
            {shownCatalog.map((skill) => (
              <div key={skill.name} className="file-row">
                <button
                  type="button"
                  className="file-left drive-folder-open"
                  onClick={() => setCatalogView(skill)}
                >
                  <span className="file-icon">🧠</span>
                  <div className="file-main">
                    <div className="file-name">{skill.name}</div>
                    <div className="file-meta">
                      {skill.description || "Claude skill"}
                    </div>
                  </div>
                </button>
                <div className="file-right">
                  <button
                    type="button"
                    className="file-download-btn"
                    onClick={() => setCatalogView(skill)}
                  >
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="files-section">
        <h3>Folders</h3>
        {shownFolders.length === 0 ? (
          <p className="file-meta">No folders here.</p>
        ) : (
          <div className="file-list">
            {shownFolders.map((folder) => (
              <div key={folder.id} className="file-row">
                {editing?.kind === "folder" && editing.id === folder.id ? (
                  <input
                    className="drive-folder-input"
                    value={editDraft}
                    autoFocus
                    aria-label="Folder name"
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="file-left drive-folder-open"
                    onClick={() =>
                      setPath((prev) => [
                        ...prev,
                        { id: folder.id, name: folder.name },
                      ])
                    }
                  >
                    <span className="file-icon">📁</span>
                    <div className="file-main">
                      <div className="file-name">{folder.name}</div>
                      <div className="file-meta">Folder</div>
                    </div>
                  </button>
                )}
                {canManage && (
                  <div className="file-right">
                    <button
                      type="button"
                      className="file-download-btn"
                      onClick={() => {
                        setEditing({ kind: "folder", id: folder.id });
                        setEditDraft(folder.name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="file-download-btn"
                      onClick={() => void removeFolder(folder.id, folder.name)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="files-section">
        <h3>Files</h3>
        {shownFiles.length === 0 ? (
          <p className="file-meta">No files here.</p>
        ) : (
          <div className="file-list">
            {shownFiles.map((file) => (
              <div key={file.id} className="file-row">
                <div className="file-left">
                  <span className="file-icon">{iconFor(file.file_type)}</span>
                  <div className="file-main">
                    {editing?.kind === "file" && editing.id === file.id ? (
                      <input
                        className="drive-folder-input"
                        value={editDraft}
                        autoFocus
                        aria-label="File name"
                        onChange={(e) => setEditDraft(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          else if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    ) : (
                      <div className="file-name">{file.name}</div>
                    )}
                    <div className="file-meta">{formatFileSize(file.size)}</div>
                  </div>
                </div>
                <div className="file-right">
                  <button
                    type="button"
                    className="file-download-btn"
                    onClick={() => void downloadSkillFile(file.id, file.name)}
                  >
                    Download
                  </button>
                  {canManage && isTextFile(file.file_type) && (
                    <button
                      type="button"
                      className="file-download-btn"
                      onClick={() => void openEditor(file)}
                    >
                      Edit
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button
                        type="button"
                        className="file-download-btn"
                        onClick={() => {
                          setEditing({ kind: "file", id: file.id });
                          setEditDraft(file.name);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="file-download-btn"
                        onClick={() => void removeFile(file.id, file.name)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New-file modal */}
      <Modal
        isOpen={creatingFile}
        onClose={() => {
          if (!savingNewFile) setCreatingFile(false);
        }}
        title="New document"
      >
        <input
          className="drive-folder-input"
          style={{ width: "100%", marginBottom: 12 }}
          value={newFileName}
          autoFocus
          placeholder="File name (e.g. notes.md)"
          onChange={(e) => setNewFileName(e.target.value)}
        />
        <textarea
          value={newFileBody}
          placeholder="Write your document…"
          onChange={(e) => setNewFileBody(e.target.value)}
          style={{
            width: "100%",
            minHeight: 220,
            resize: "vertical",
            fontFamily: "inherit",
            padding: 8,
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="drive-folder-create-btn"
            disabled={savingNewFile || !newFileName.trim()}
            onClick={() => void submitNewFile()}
          >
            {savingNewFile ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            className="drive-folder-cancel-btn"
            disabled={savingNewFile}
            onClick={() => setCreatingFile(false)}
          >
            Cancel
          </button>
        </div>
      </Modal>

      {/* Read-only Claude skill viewer */}
      <Modal
        isOpen={catalogView !== null}
        onClose={() => setCatalogView(null)}
        title={catalogView ? `Claude Skill — ${catalogView.name}` : "Skill"}
      >
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "60vh",
            overflow: "auto",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 13,
            margin: 0,
          }}
        >
          {catalogView?.content}
        </pre>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="drive-folder-cancel-btn"
            onClick={() => setCatalogView(null)}
          >
            Close
          </button>
        </div>
      </Modal>

      {/* Content editor modal */}
      <Modal
        isOpen={editorFile !== null}
        onClose={() => {
          if (!editorSaving) setEditorFile(null);
        }}
        title={editorFile ? `Edit — ${editorFile.name}` : "Edit"}
      >
        {editorLoading ? (
          <p className="file-meta">Loading…</p>
        ) : (
          <>
            <textarea
              ref={editorTextareaRef}
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              style={{
                width: "100%",
                minHeight: 300,
                resize: "vertical",
                fontFamily: "inherit",
                padding: 8,
                boxSizing: "border-box",
              }}
            />

            <div className="doc-editor-tools">
              <button
                type="button"
                className="doc-tool-btn"
                aria-expanded={attachOpen}
                disabled={editorSaving}
                onClick={() => setAttachOpen((v) => !v)}
                data-tooltip="Insert a link to a skills file"
              >
                📎 Attach
              </button>
              <button
                type="button"
                className="doc-tool-btn"
                disabled={aiDisabled}
                onClick={runGrammarFix}
                data-tooltip={
                  editorContent.length > MAX_AI_CHARS
                    ? "Document is too large for AI assist"
                    : "Correct spelling & grammar"
                }
              >
                {aiBusy === "fix" ? "Working…" : "✨ Fix grammar & spelling"}
              </button>
              <button
                type="button"
                className="doc-tool-btn"
                disabled={aiDisabled}
                onClick={runSummary}
                data-tooltip="Plain-language summary"
              >
                {aiBusy === "summary" ? "Working…" : "📝 Summarize"}
              </button>
            </div>

            {attachOpen &&
              (() => {
                const others = files.filter((f) => f.id !== editorFile?.id);
                return (
                  <div className="doc-attach-picker">
                    {others.length === 0 ? (
                      <p className="file-meta">
                        No other files in this folder to link.
                      </p>
                    ) : (
                      others.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className="doc-attach-item"
                          onClick={() => insertFileReference(f)}
                        >
                          <span aria-hidden="true">{iconFor(f.file_type)}</span>
                          <span className="doc-attach-item-name">{f.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                );
              })()}

            {aiError && <p className="doc-ai-error">{aiError}</p>}

            {grammarSuggestion !== null && (
              <div className="doc-ai-panel">
                <div className="doc-ai-panel-head">Suggested correction</div>
                <div className="doc-ai-panel-body">{grammarSuggestion}</div>
                <div className="doc-ai-panel-actions">
                  <button
                    type="button"
                    className="drive-folder-create-btn"
                    onClick={applyGrammar}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="drive-folder-cancel-btn"
                    onClick={() => setGrammarSuggestion(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {summary !== null && (
              <div className="doc-ai-panel">
                <div className="doc-ai-panel-head">Summary</div>
                <div className="doc-ai-panel-body">{summary}</div>
                <div className="doc-ai-panel-actions">
                  <button
                    type="button"
                    className="drive-folder-create-btn"
                    onClick={copySummary}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="drive-folder-cancel-btn"
                    onClick={() => setSummary(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="drive-folder-create-btn"
                disabled={editorSaving}
                onClick={() => void saveEditor()}
              >
                {editorSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="drive-folder-cancel-btn"
                disabled={editorSaving}
                onClick={() => setEditorFile(null)}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
