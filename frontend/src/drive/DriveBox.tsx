import { logger } from "../utils/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import "./drive.css";
import {
  getDriveFiles,
  uploadDriveFiles,
  downloadDriveFile,
  listFolders,
  createFolder,
  deleteFolder,
  type UploadedFile,
  type Folder,
} from "../api/drive";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import { formatFileSize } from "../emails/renderUtils";
import DriveThumbnail from "./DriveThumbnail";

// Breadcrumb entry. The root is encoded with id=null so the same shape works
// for "Drive" and any nested folder name.
type Crumb = { id: number | null; name: string };

const ROOT_CRUMB: Crumb = { id: null, name: "Drive" };

export default function Drive() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();

  // === Folder navigation state ===
  // `path` is the breadcrumb from root → current folder. `currentFolderId` is
  // derived from the last crumb. Click a crumb to jump up; click a folder
  // card to push onto the path.
  const [path, setPath] = useState<Crumb[]>([ROOT_CRUMB]);
  const currentFolderId = path[path.length - 1]?.id ?? null;

  // === Folder list at the current location ===
  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  // === "New folder" inline form ===
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  // === Existing file state ===
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Layout for folders/files: list, (small) grid, or large grid. Persisted so
  // the choice sticks. Chosen via the top-right "Layout" dropdown.
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
      // private mode / quota — preference just won't persist this session.
    }
  }, [viewMode]);
  // Close the Layout dropdown on an outside click.
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

  // Refetch files + folders whenever the user changes folders. The backend
  // narrows by folder_id; we mirror that on the client so search/filter only
  // apply within the current folder.
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

  // === Folder operations ===
  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      const folder = await createFolder(name, currentFolderId);
      setNewFolderName("");
      setCreatingFolder(false);
      // Navigate into the folder we just made. The upload drop-zone targets
      // `currentFolderId`, so without this the user stays at the parent and an
      // upload right after creating a folder lands in the parent/root instead
      // of the new folder. Pushing the crumb also triggers the fetch effect to
      // load the (empty) new folder's contents.
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

  const removeFolder = async (folder: Folder) => {
    const confirmed = window.confirm(
      `Delete "${folder.name}" and everything inside it? This can't be undone.`
    );
    if (!confirmed) return;
    try {
      await deleteFolder(folder.id);
      void fetchFolders();
      // Files inside this folder are gone too; if any happened to be in the
      // current view (shouldn't be — folder was a child here), refresh.
      void fetchFiles();
    } catch (err) {
      logger.error("deleteFolder failed", err);
      setError("Could not delete folder.");
    }
  };

  // === File operations ===
  // One-step upload: picking files (toolbar button) or dropping them uploads
  // straight to the current folder — no staging step, so the control fits a
  // single compact toolbar line.
  const uploadSelected = async (selected: FileList | null) => {
    if (!selected || selected.length === 0) return;
    if (!user) {
      setError("User not logged in");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      // Pass the user id so uploadDriveFiles wraps each blob in the
      // WV1 envelope before sending. Server stores opaque ciphertext.
      await uploadDriveFiles(Array.from(selected), currentFolderId, user.id);
      void fetchFiles();
    } catch (err) {
      logger.error("Upload error:", err);
      setError(
        err instanceof Error ? err.message : "Upload failed. Please try again."
      );
    } finally {
      setUploading(false);
      // Nudge the global storage banner to re-check usage — storage went up on
      // a successful upload, or the limit was hit on a 402. Matches
      // StorageLimitBanner's STORAGE_CHANGED_EVENT name.
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
      // Same user id contract — download path auto-detects the WV1
      // envelope and decrypts client-side. Pre-E2E plaintext files
      // pass through unchanged.
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


  // === Filtering ===
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

  // Distinct glyphs per layout so the trigger + menu read clearly: List = rows,
  // Grid = a dense 3×3 of small cells, Large grid = a 2×2 of big cells.
  const layoutIcon = (mode: ViewMode) => {
    if (mode === "list") {
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
          <rect x="3" y="5" width="18" height="3" rx="1" />
          <rect x="3" y="10.5" width="18" height="3" rx="1" />
          <rect x="3" y="16" width="18" height="3" rx="1" />
        </svg>
      );
    }
    if (mode === "large") {
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
          <rect x="3" y="3" width="8" height="8" rx="1.5" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" />
        </svg>
      );
    }
    // small grid — 3×3
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
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
      {/* 🔹 Compact toolbar: breadcrumb + upload / new folder / view toggle */}
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
            title="Upload files to this folder"
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
          {/* Layout dropdown — pinned to the far right of the breadcrumb bar. */}
          <div className="drive-layout-menu" ref={layoutMenuRef}>
            <button
              type="button"
              className="drive-view-btn drive-layout-trigger"
              onClick={() => setLayoutMenuOpen((o) => !o)}
              title="Layout"
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

      {/* Drag-and-drop works anywhere on the Drive area (handler on the
          container); the toolbar "⬆ Upload" button covers click-to-upload. A
          thin hint replaces the old full-height drop zone. */}
      <p className="drive-drop-hint">
        Drag &amp; drop files anywhere, or use ⬆ Upload — into{" "}
        <strong>{path[path.length - 1]?.name ?? "Drive"}</strong>
      </p>

      {error && <p className="drive-error-msg">{error}</p>}

      {/* 🔹 Folders Section */}
      {(visibleFolders.length > 0 || foldersLoading) && (
        <div className="files-section">
          <h3>📂 Folders</h3>
          {foldersLoading ? (
            <p>Loading folders…</p>
          ) : (
            <div className={fileListClass}>
              {visibleFolders.map((folder) => (
                <div key={folder.id} className="file-row">
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
                  <div className="file-right">
                    <button
                      className="file-download-btn"
                      onClick={() => void removeFolder(folder)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 🔹 Files Section */}
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
                <div className="file-left">
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
                      {file.file_type} • {formatFileSize(file.size)}
                    </div>
                  </div>
                </div>

                <div className="file-right">
                  <button
                    className="file-download-btn"
                    onClick={() => downloadFile(file)}
                  >
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
