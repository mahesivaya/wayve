import { logger } from "../utils/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import "./drive.css";
import {
  getDriveFiles,
  uploadDriveFiles,
  downloadDriveFile,
  fetchDriveFileBlob,
  renameDriveFile,
  deleteDriveFile,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  type UploadedFile,
  type Folder,
} from "../api/drive";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import { formatFileSize } from "../emails/renderUtils";
import DriveThumbnail from "./DriveThumbnail";

// The root is encoded with id=null so the same shape works for "Drive" and any
// nested folder.
type Crumb = { id: number | null; name: string };

const ROOT_CRUMB: Crumb = { id: null, name: "Drive" };

export default function Drive() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();

  // `path` is the breadcrumb from root to the current folder, and
  // `currentFolderId` is derived from its last entry.
  const [path, setPath] = useState<Crumb[]>([ROOT_CRUMB]);
  const currentFolderId = path[path.length - 1]?.id ?? null;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Files and folders share the same row menu but keep independent open/rename
  // state, because a file id and a folder id can collide (different tables).
  type InfoItem = {
    name: string;
    type: string;
    size: number | null;
    created_at: string;
  };
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menuOpenFolderId, setMenuOpenFolderId] = useState<number | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState("");
  const [infoItem, setInfoItem] = useState<InfoItem | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const folderMenuRef = useRef<HTMLDivElement | null>(null);

  // `previewUrl` is the decrypted object URL, revoked when the preview closes.
  const [previewFile, setPreviewFile] = useState<UploadedFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  // Close the open row menu on an outside click. Rename and info stay open,
  // since they are explicit modes.
  useEffect(() => {
    if (menuOpenId == null) return;
    const onDown = (e: MouseEvent) => {
      if (!fileMenuRef.current?.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpenId]);
  useEffect(() => {
    if (menuOpenFolderId == null) return;
    const onDown = (e: MouseEvent) => {
      if (!folderMenuRef.current?.contains(e.target as Node)) {
        setMenuOpenFolderId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpenFolderId]);

  // The layout choice is persisted so it sticks across visits.
  type ViewMode = "list" | "grid" | "large";
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem("rwayve.drive.view");
      return v === "grid" || v === "large" ? v : "list";
    } catch {
      return "list";
    }
  });
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("rwayve.drive.view", viewMode);
    } catch {
      // Private mode or quota: the preference just won't persist.
    }
  }, [viewMode]);
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!layoutMenuRef.current?.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [layoutMenuOpen]);
  const fileListClass = `file-list${
    viewMode === "grid"
      ? " file-list--grid"
      : viewMode === "large"
        ? " file-list--grid file-list--grid-large"
        : ""
  }`;

  // Files and folders are refetched whenever the user changes folders. The
  // backend narrows by folder_id, and the client mirrors that so search and
  // filtering only apply within the current folder.
  const fetchFolders = useCallback(async () => {
    if (!user) return;
    setFoldersLoading(true);
    try {
      const data = await listFolders(currentFolderId);
      setFolders(Array.isArray(data) ? data : []);
    } catch (err) {
      logger.error("listFolders failed", err);
      setError("Failed to load folders.");
    } finally {
      setFoldersLoading(false);
    }
  }, [user, currentFolderId]);

  const fetchFiles = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getDriveFiles(currentFolderId);
      setUploadedFiles(Array.isArray(data) ? data : []);
    } catch (err) {
      logger.error("Fetch error:", err);
      setError("Failed to load files.");
    } finally {
      setLoading(false);
    }
  }, [user, currentFolderId]);

  useEffect(() => {
    if (user?.id) {
      const timer = window.setTimeout(() => {
        void fetchFolders();
        void fetchFiles();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [fetchFolders, fetchFiles, user?.id]);

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const folder = await createFolder(name, currentFolderId);
      setNewFolderName("");
      setCreatingFolder(false);
      // Navigate into the new folder. The upload drop-zone targets
      // `currentFolderId`, so without this an upload right after creating a
      // folder would land in the parent instead.
      setPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
    } catch (err) {
      logger.error("createFolder failed", err);
      setError("Could not create folder.");
    }
  };

  const openFolder = (folder: Folder) => {
    setPath((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const goToCrumb = (index: number) => {
    setPath((prev) => prev.slice(0, index + 1));
  };

  const startRenameFolder = (folder: Folder) => {
    setMenuOpenFolderId(null);
    setRenamingFolderId(folder.id);
    setRenameFolderValue(folder.name);
  };

  const submitRenameFolder = async (folder: Folder) => {
    const name = renameFolderValue.trim();
    if (!name || name === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    try {
      setError(null);
      await renameFolder(folder.id, name);
      setFolders((prev) =>
        prev.map((f) => (f.id === folder.id ? { ...f, name } : f))
      );
    } catch (err) {
      logger.error("renameFolder failed", err);
      setError("Could not rename folder.");
    } finally {
      setRenamingFolderId(null);
    }
  };

  const removeFolder = async (folder: Folder) => {
    setMenuOpenFolderId(null);
    const confirmed = window.confirm(
      `Delete "${folder.name}" and everything inside it? This can't be undone.`
    );
    if (!confirmed) return;
    try {
      await deleteFolder(folder.id);
      void fetchFolders();
      // The files inside the deleted folder are gone too, so refresh the view.
      void fetchFiles();
    } catch (err) {
      logger.error("deleteFolder failed", err);
      setError("Could not delete folder.");
    }
  };

  // Upload is one step: picking or dropping files sends them straight to the
  // current folder, with no staging step in between.
  const uploadSelected = async (selected: FileList | null) => {
    if (!selected || selected.length === 0) return;
    if (!user) {
      setError("User not logged in");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      // The user id makes uploadDriveFiles wrap each blob in the WV1 envelope
      // before sending, so the server only ever stores opaque ciphertext.
      await uploadDriveFiles(Array.from(selected), currentFolderId, user.id);
      void fetchFiles();
    } catch (err) {
      logger.error("Upload error:", err);
      setError(
        err instanceof Error ? err.message : "Upload failed. Please try again."
      );
    } finally {
      setUploading(false);
      // Nudge the global storage banner to re-check usage. The event name must
      // stay in sync with StorageLimitBanner's STORAGE_CHANGED_EVENT.
      window.dispatchEvent(new Event("rwayve:storage-changed"));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void uploadSelected(e.dataTransfer.files);
  };

  const downloadFile = async (file: UploadedFile) => {
    try {
      setError(null);
      // The download path auto-detects the WV1 envelope and decrypts
      // client-side. Pre-E2E plaintext files pass through unchanged.
      await downloadDriveFile(file.id, file.name, user?.id ?? null);
    } catch (err) {
      logger.error("Download error:", err);
      setError(
        err instanceof Error
          ? `Download failed: ${err.message}`
          : "Download failed."
      );
    }
  };

  // Types that render inline in the preview modal. Everything else offers only
  // a Download button.
  const PREVIEW_IMAGE_TYPES = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
  ]);
  const previewKind = (file: UploadedFile | null): "image" | "pdf" | "none" => {
    const t = (file?.file_type || "").toLowerCase();
    if (PREVIEW_IMAGE_TYPES.has(t)) return "image";
    if (t === "pdf") return "pdf";
    return "none";
  };

  // The download endpoint always serves application/octet-stream, since files
  // are E2E-encrypted and the server can't know the real type. An <iframe>
  // downloads an octet-stream blob instead of rendering it, so the MIME type
  // must be derived from the extension before building the object URL.
  const PREVIEW_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };

  // A browser configured to download PDFs rather than display them shows a
  // "content is blocked" error in an <iframe>, so offer a download instead.
  // `pdfViewerEnabled` is false exactly when inline viewing is unavailable, and
  // undefined on older browsers, which is treated as "try inline".
  const canViewPdfInline =
    (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false;

  const openPreview = async (file: UploadedFile) => {
    setPreviewFile(file);
    setPreviewError(null);
    // Clearing the URL revokes the previous one; the effect handles revocation.
    setPreviewUrl(null);
    // Only inline-renderable kinds need their bytes fetched.
    if (previewKind(file) === "none") return;
    setPreviewLoading(true);
    try {
      const blob = await fetchDriveFileBlob(file.id, user?.id ?? null);
      // Retag the blob with the right MIME so the browser renders it inline.
      // `slice` does this without copying.
      const mime = PREVIEW_MIME[(file.file_type || "").toLowerCase()];
      setPreviewUrl(
        URL.createObjectURL(mime ? blob.slice(0, blob.size, mime) : blob)
      );
    } catch (err) {
      logger.error("preview load failed", err);
      setPreviewError("Could not open preview.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const startRename = (file: UploadedFile) => {
    setMenuOpenId(null);
    setRenamingId(file.id);
    setRenameValue(file.name);
  };

  const submitRename = async (file: UploadedFile) => {
    const name = renameValue.trim();
    if (!name || name === file.name) {
      setRenamingId(null);
      return;
    }
    try {
      setError(null);
      await renameDriveFile(file.id, name);
      // Patch locally so the row updates without a round-trip. `file_type` is
      // derived from the new extension to match what the server will store.
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === file.id
            ? { ...f, name, file_type: name.split(".").pop() ?? f.file_type }
            : f
        )
      );
    } catch (err) {
      logger.error("renameDriveFile failed", err);
      setError("Could not rename file.");
    } finally {
      setRenamingId(null);
    }
  };

  const removeFile = async (file: UploadedFile) => {
    setMenuOpenId(null);
    const confirmed = window.confirm(
      `Delete "${file.name}"? This can't be undone.`
    );
    if (!confirmed) return;
    try {
      setError(null);
      await deleteDriveFile(file.id);
      setUploadedFiles((prev) => prev.filter((f) => f.id !== file.id));
      window.dispatchEvent(new Event("rwayve:storage-changed"));
    } catch (err) {
      logger.error("deleteDriveFile failed", err);
      setError("Could not delete file.");
    }
  };

  const visibleFolders = normalizedSearchQuery
    ? folders.filter((f) =>
        f.name.toLowerCase().includes(normalizedSearchQuery)
      )
    : folders;

  const visibleUploadedFiles = normalizedSearchQuery
    ? uploadedFiles.filter((file) =>
        [file.name, file.file_type, file.size.toString(), file.created_at]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : uploadedFiles;

  const layoutIcon = (mode: ViewMode) => {
    if (mode === "list") {
      return (
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="currentColor"
        >
          <rect x="3" y="5" width="18" height="3" rx="1" />
          <rect x="3" y="10.5" width="18" height="3" rx="1" />
          <rect x="3" y="16" width="18" height="3" rx="1" />
        </svg>
      );
    }
    if (mode === "large") {
      return (
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          fill="currentColor"
        >
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
        </svg>
      );
    }
    return (
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="currentColor"
      >
        {[3, 9.5, 16].map((y) =>
          [3, 9.5, 16].map((x) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx="1" />
          ))
        )}
      </svg>
    );
  };

  return (
    <div
      className="drive-container"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="drive-breadcrumb">
        {path.map((crumb, idx) => (
          <span key={`${crumb.id ?? "root"}-${idx}`} className="drive-crumb">
            {idx > 0 && <span className="drive-crumb-sep"> / </span>}
            <button
              type="button"
              className="drive-crumb-link"
              onClick={() => goToCrumb(idx)}
              disabled={idx === path.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
        <div className="drive-breadcrumb-actions">
          <label
            className={`drive-folder-new-btn drive-upload-btn${uploading ? " is-busy" : ""}`}
            data-tooltip="Upload files to this folder"
          >
            {uploading ? "Uploading…" : "⬆ Upload"}
            <input
              type="file"
              multiple
              hidden
              disabled={uploading}
              onChange={(e) => {
                void uploadSelected(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          {creatingFolder ? (
            <>
              <input
                type="text"
                className="drive-folder-input"
                value={newFolderName}
                placeholder="Folder name"
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitNewFolder();
                  if (e.key === "Escape") {
                    setCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
                autoFocus
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
            <button
              type="button"
              className="drive-folder-new-btn"
              onClick={() => setCreatingFolder(true)}
            >
              + New folder
            </button>
          )}
          <div className="drive-layout-menu" ref={layoutMenuRef}>
            <button
              type="button"
              className="drive-view-btn drive-layout-trigger"
              onClick={() => setLayoutMenuOpen((o) => !o)}
              data-tooltip="Layout"
              aria-label="Layout"
              aria-haspopup="menu"
              aria-expanded={layoutMenuOpen}
            >
              {layoutIcon(viewMode)}
            </button>
            {layoutMenuOpen && (
              <div className="drive-layout-dropdown" role="menu">
                <div className="drive-layout-heading">Layout</div>
                {(
                  [
                    ["grid", "Grid"],
                    ["large", "Large grid"],
                    ["list", "List"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    role="menuitemradio"
                    aria-checked={viewMode === val}
                    className="drive-layout-item"
                    onClick={() => {
                      setViewMode(val);
                      setLayoutMenuOpen(false);
                    }}
                  >
                    <span className="drive-layout-check">
                      {viewMode === val ? "✓" : ""}
                    </span>
                    <span className="drive-layout-label">{label}</span>
                    <span className="drive-layout-icon">{layoutIcon(val)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drop is handled on the container, so drag-and-drop works anywhere on
          the Drive area. */}
      <p className="drive-drop-hint">
        Drag &amp; drop files anywhere, or use ⬆ Upload — into{" "}
        <strong>{path[path.length - 1]?.name ?? "Drive"}</strong>
      </p>

      {error && <p className="drive-error-msg">{error}</p>}

      {(visibleFolders.length > 0 || foldersLoading) && (
        <div className="files-section">
          <h3>📂 Folders</h3>
          {foldersLoading ? (
            <p>Loading folders…</p>
          ) : (
            <div className={fileListClass}>
              {visibleFolders.map((folder) => (
                <div key={folder.id} className="file-row">
                  {renamingFolderId === folder.id ? (
                    // While renaming, the row's left side can't be the "open
                    // folder" button, because an <input> can't live inside a
                    // <button>.
                    <div className="file-left">
                      <span className="file-icon">📁</span>
                      <div className="file-main">
                        <input
                          type="text"
                          className="drive-folder-input file-rename-input"
                          value={renameFolderValue}
                          onChange={(e) => setRenameFolderValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              void submitRenameFolder(folder);
                            if (e.key === "Escape") setRenamingFolderId(null);
                          }}
                          onBlur={() => void submitRenameFolder(folder)}
                          autoFocus
                        />
                        <div className="file-meta">Folder</div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="file-left drive-folder-open"
                      onClick={() => openFolder(folder)}
                    >
                      <span className="file-icon">📁</span>
                      <div className="file-main">
                        <div className="file-name">{folder.name}</div>
                        <div className="file-meta">Folder</div>
                      </div>
                    </button>
                  )}
                  <div className="file-right">
                    <div
                      className="drive-file-menu"
                      ref={
                        menuOpenFolderId === folder.id
                          ? folderMenuRef
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        className="drive-file-menu-trigger"
                        onClick={() =>
                          setMenuOpenFolderId((id) =>
                            id === folder.id ? null : folder.id
                          )
                        }
                        data-tooltip="More actions"
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpenFolderId === folder.id}
                      >
                        ⋯
                      </button>
                      {menuOpenFolderId === folder.id && (
                        <div className="drive-file-menu-dropdown" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="drive-file-menu-item"
                            onClick={() => {
                              setMenuOpenFolderId(null);
                              openFolder(folder);
                            }}
                          >
                            📂 Open
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="drive-file-menu-item"
                            onClick={() => startRenameFolder(folder)}
                          >
                            ✎ Rename
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="drive-file-menu-item"
                            onClick={() => {
                              setMenuOpenFolderId(null);
                              setInfoItem({
                                name: folder.name,
                                type: "Folder",
                                size: null,
                                created_at: folder.created_at,
                              });
                            }}
                          >
                            ⓘ Folder info
                          </button>
                          <div className="drive-file-menu-sep" />
                          <button
                            type="button"
                            role="menuitem"
                            className="drive-file-menu-item drive-file-menu-item--danger"
                            onClick={() => void removeFolder(folder)}
                          >
                            🗑 Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="files-section">
        <h3>📁 Uploaded Files</h3>

        {loading ? (
          <p>Loading...</p>
        ) : !visibleUploadedFiles || visibleUploadedFiles.length === 0 ? (
          <p>
            {normalizedSearchQuery
              ? "No files match your search"
              : "No files uploaded yet"}
          </p>
        ) : (
          <div className={fileListClass}>
            {visibleUploadedFiles.map((file) => (
              <div key={file.id} className="file-row">
                {renamingId === file.id ? (
                  // While renaming, the left side can't be the "open preview"
                  // button, because an <input> can't live inside a <button>.
                  <div className="file-left">
                    <DriveThumbnail
                      file={file}
                      userId={user?.id ?? null}
                      fallback="📄"
                    />
                    <div className="file-main">
                      <input
                        type="text"
                        className="drive-folder-input file-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitRename(file);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => void submitRename(file)}
                        autoFocus
                      />
                      <div className="file-meta">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="file-left drive-folder-open"
                    onClick={() => void openPreview(file)}
                    data-tooltip="Open preview"
                    aria-label="Open preview"
                  >
                    <DriveThumbnail
                      file={file}
                      userId={user?.id ?? null}
                      fallback={
                        file.file_type === "png" || file.file_type === "jpg"
                          ? "🖼️"
                          : file.file_type === "pdf"
                            ? "📕"
                            : file.file_type === "zip"
                              ? "🗜️"
                              : "📄"
                      }
                    />
                    <div className="file-main">
                      <div className="file-name">{file.name}</div>
                      <div className="file-meta">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                  </button>
                )}

                <div className="file-right">
                  <div
                    className="drive-file-menu"
                    ref={menuOpenId === file.id ? fileMenuRef : undefined}
                  >
                    <button
                      type="button"
                      className="drive-file-menu-trigger"
                      onClick={() =>
                        setMenuOpenId((id) => (id === file.id ? null : file.id))
                      }
                      data-tooltip="More actions"
                      aria-label="More actions"
                      aria-haspopup="menu"
                      aria-expanded={menuOpenId === file.id}
                    >
                      ⋯
                    </button>
                    {menuOpenId === file.id && (
                      <div className="drive-file-menu-dropdown" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="drive-file-menu-item"
                          onClick={() => {
                            setMenuOpenId(null);
                            void downloadFile(file);
                          }}
                        >
                          ⬇ Download
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="drive-file-menu-item"
                          onClick={() => startRename(file)}
                        >
                          ✎ Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="drive-file-menu-item"
                          onClick={() => {
                            setMenuOpenId(null);
                            setInfoItem({
                              name: file.name,
                              type: file.file_type,
                              size: file.size,
                              created_at: file.created_at,
                            });
                          }}
                        >
                          ⓘ File info
                        </button>
                        <div className="drive-file-menu-sep" />
                        <button
                          type="button"
                          role="menuitem"
                          className="drive-file-menu-item drive-file-menu-item--danger"
                          onClick={() => void removeFile(file)}
                        >
                          🗑 Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewFile && (
        <div
          className="drive-preview-overlay"
          onClick={closePreview}
          role="presentation"
        >
          <div
            className="drive-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label={previewFile.name}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drive-preview-header">
              <span className="drive-preview-title" data-tooltip={previewFile.name}>
                {previewFile.name}
              </span>
              <div className="drive-preview-actions">
                <button
                  type="button"
                  className="file-download-btn"
                  onClick={() => void downloadFile(previewFile)}
                >
                  ⬇ Download
                </button>
                <button
                  type="button"
                  className="drive-info-close"
                  onClick={closePreview}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="drive-preview-body">
              {previewLoading ? (
                <p className="drive-preview-msg">Loading…</p>
              ) : previewError ? (
                <p className="drive-preview-msg">{previewError}</p>
              ) : previewKind(previewFile) === "image" && previewUrl ? (
                <img
                  className="drive-preview-image"
                  src={previewUrl}
                  alt={previewFile.name}
                />
              ) : previewKind(previewFile) === "pdf" &&
                previewUrl &&
                canViewPdfInline ? (
                <iframe
                  className="drive-preview-frame"
                  src={previewUrl}
                  title={previewFile.name}
                />
              ) : previewKind(previewFile) === "pdf" ? (
                <p className="drive-preview-msg">
                  Not able to open. Please download.
                </p>
              ) : (
                <p className="drive-preview-msg">
                  No inline preview for this file type. Use Download to open it.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {infoItem && (
        <div
          className="drive-info-overlay"
          onClick={() => setInfoItem(null)}
          role="presentation"
        >
          <div
            className="drive-info-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Info"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drive-info-header">
              <h4 className="drive-info-title">
                {infoItem.size == null ? "Folder info" : "File info"}
              </h4>
              <button
                type="button"
                className="drive-info-close"
                onClick={() => setInfoItem(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <dl className="drive-info-list">
              <dt>Name</dt>
              <dd>{infoItem.name}</dd>
              <dt>Type</dt>
              <dd>{infoItem.type || "—"}</dd>
              {infoItem.size != null && (
                <>
                  <dt>Size</dt>
                  <dd>{formatFileSize(infoItem.size)}</dd>
                </>
              )}
              <dt>Created</dt>
              <dd>{new Date(infoItem.created_at).toLocaleString()}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
