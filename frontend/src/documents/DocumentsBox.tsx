import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../utils/logger";
import { sendAiChat } from "../api/ai";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { useGlobalSearch } from "../search/SearchContext";
import { formatFileSize } from "../emails/renderUtils";
import Modal from "../components/Modal";
import {
  listDocumentFolders,
  createDocumentFolder,
  renameDocumentFolder,
  deleteDocumentFolder,
  listDocuments,
  uploadDocuments,
  renameDocument,
  deleteDocument,
  downloadDocument,
  createTextDocument,
  getDocumentContent,
  updateDocumentContent,
  type DocumentFolder,
  type DocumentFile,
} from "../api/documents";
import "../drive/drive.css";

// Breadcrumb entry; the root is id=null ("Documents").
type Crumb = { id: number | null; name: string };
const ROOT_CRUMB: Crumb = { id: null, name: "Documents" };

// What's being renamed inline (a file or a folder), if anything.
type Editing = { kind: "file" | "folder"; id: number } | null;

// File types we can open in the in-app text editor. Binary files (images,
// PDFs, archives) are download-only.
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

// Above this many characters the whole-document AI prompt gets impractical, so
// the assist buttons disable rather than firing a huge request.
const MAX_AI_CHARS = 100_000;

// Prompts are tag-delimited and instruct "return ONLY …" so the assistant
// replies with plain text and no preamble, quotes, or tool chatter.
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

export default function DocumentsBox() {
  const { user } = useAuth();
  // Only owners / super_admins may create, edit, rename, delete, or upload.
  // Every other member gets a read-only view (list / view / download). The
  // backend enforces this independently via the `documents:manage` permission;
  // this flag just hides the controls.
  const canManage = hasPermission(user, "documents:manage");
  const { normalizedSearchQuery } = useGlobalSearch();

  const [path, setPath] = useState<Crumb[]>([ROOT_CRUMB]);
  const currentFolderId = path[path.length - 1]?.id ?? null;

  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [editDraft, setEditDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-file (author-in-app) modal.
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFileBody, setNewFileBody] = useState("");
  const [savingNewFile, setSavingNewFile] = useState(false);

  // Content editor modal.
  const [editorFile, setEditorFile] = useState<DocumentFile | null>(null);
  const [editorContent, setEditorContent] = useState("");
  // The content as it was fetched, so Save can tell an untouched editor from an
  // edited one — opening a document to read it shouldn't be savable.
  const [loadedContent, setLoadedContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  // Ref to the editor textarea so file references insert at the caret.
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Editor assist state: which AI action is in flight, the pending grammar
  // suggestion (awaiting Apply/Discard), the read-only summary, any assist error,
  // and whether the attach-file picker is open. All reset when a file opens.
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
      const [f, d] = await Promise.all([
        listDocumentFolders(currentFolderId),
        listDocuments(currentFolderId),
      ]);
      setFolders(Array.isArray(f) ? f : []);
      setFiles(Array.isArray(d) ? d : []);
    } catch (err) {
      logger.error("documents load failed", err);
      setError("Failed to load documents.");
    }
  }, [user, currentFolderId]);

  // Deferred with setTimeout(0) to keep the fetch (and its setState) out of the
  // synchronous effect body — mirrors DriveBox and satisfies the hooks lint.
  useEffect(() => {
    const timer = window.setTimeout(() => void fetchAll(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const doUpload = async (incoming: File[]) => {
    if (incoming.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      await uploadDocuments(incoming, currentFolderId);
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
      await createDocumentFolder(name, currentFolderId);
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
      await createTextDocument(name, newFileBody, currentFolderId);
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
    setLoadedContent("");
    setEditorLoading(true);
    setError(null);
    // Clear any assist state left over from a previously edited file.
    setAiBusy(null);
    setGrammarSuggestion(null);
    setSummary(null);
    setAiError(null);
    setAttachOpen(false);
    try {
      const data = await getDocumentContent(file.id);
      setEditorContent(data.content);
      setLoadedContent(data.content);
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
      await updateDocumentContent(editorFile.id, editorContent);
      setEditorFile(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save document");
    } finally {
      setEditorSaving(false);
    }
  };

  // Save stays dead until the buffer differs from what was fetched. An AI assist
  // that rewrites the content counts, same as typing.
  const editorDirty = editorContent !== loadedContent;

  // Whether the AI assist buttons are usable: nothing else in flight, not saving,
  // there's trimmed content, and the document isn't too large to send.
  const aiDisabled =
    aiBusy !== null ||
    editorSaving ||
    editorContent.trim().length === 0 ||
    editorContent.length > MAX_AI_CHARS;

  // Run one whole-document AI assist. `build` turns the content into a prompt;
  // `onReply` stashes the plain-text reply (grammar suggestion or summary).
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

  // Accept the grammar suggestion into the editor (still requires Save).
  const applyGrammar = () => {
    if (grammarSuggestion === null) return;
    setEditorContent(grammarSuggestion);
    setGrammarSuggestion(null);
  };

  const copySummary = () => {
    if (summary === null) return;
    void navigator.clipboard?.writeText(summary).catch(() => undefined);
  };

  // Insert a Markdown reference to another library file at the caret (or append
  // if the textarea isn't focused). The link is the in-app authenticated route.
  // Wrapped so the textarea ref is only read at click time, never during render.
  const insertFileReference = useCallback((file: DocumentFile) => {
    const ref = `[${file.name}](/api/documents/${file.id}/download)`;
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
      if (target.kind === "folder") await renameDocumentFolder(target.id, name);
      else await renameDocument(target.id, name);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  const removeFolder = async (id: number, name: string) => {
    if (!window.confirm(`Delete folder "${name}" and everything inside it?`))
      return;
    try {
      await deleteDocumentFolder(id);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const removeFile = async (id: number, name: string) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    try {
      await deleteDocument(id);
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

  return (
    <div className="drive-container">
      {/* Breadcrumb — hidden at the root, where the only crumb would repeat the
          page heading; kept when there are folder crumbs or manage actions. */}
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

      {/* Upload / header */}
      <div className="upload-section">
        <div className="drive-header">
          <h2>Documents</h2>
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

      {/* Folders */}
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

      {/* Files */}
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
                    onClick={() => void downloadDocument(file.id, file.name)}
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

            {/* Attach + AI assist toolbar. */}
            <div className="doc-editor-tools">
              <button
                type="button"
                className="doc-tool-btn"
                aria-expanded={attachOpen}
                disabled={editorSaving}
                onClick={() => setAttachOpen((v) => !v)}
                data-tooltip="Insert a link to a library file"
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
                disabled={editorSaving || !editorDirty}
                title={editorDirty ? undefined : "No changes to save"}
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
