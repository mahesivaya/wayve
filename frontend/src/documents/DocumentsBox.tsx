import { useCallback, useEffect, useState } from "react";
import { logger } from "../utils/logger";
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
  "txt", "md", "markdown", "csv", "json", "log", "yml", "yaml",
  "html", "css", "js", "ts", "xml", "rtf", "text",
];
const isTextFile = (t: string | null): boolean =>
  TEXT_TYPES.includes((t ?? "").toLowerCase());

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
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);

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
      setError(err instanceof Error ? err.message : "Failed to create document");
    } finally {
      setSavingNewFile(false);
    }
  };

  const openEditor = async (file: DocumentFile) => {
    setEditorFile(file);
    setEditorContent("");
    setEditorLoading(true);
    setError(null);
    try {
      const data = await getDocumentContent(file.id);
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
      await updateDocumentContent(editorFile.id, editorContent);
      setEditorFile(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save document");
    } finally {
      setEditorSaving(false);
    }
  };

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
      {/* Breadcrumb */}
      <div className="drive-breadcrumb">
        {path.map((crumb, idx) => (
          <span key={`${crumb.id ?? "root"}-${idx}`} className="drive-crumb">
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
