import { logger } from "../utils/logger";
import { useCallback, useEffect, useState } from "react";
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
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await createFolder(name, currentFolderId);
      setNewFolderName("");
      setCreatingFolder(false);
      void fetchFolders();
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
      `Delete "${folder.name}" and everything inside it? This can't be undone.`,
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
  const handleFiles = (selected: FileList | null) => {
    if (!selected) return;
    setFiles((prev) => [...prev, ...Array.from(selected)]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadFiles = async () => {
    setError(null);
    if (!files.length) {
      setError("No files selected");
      return;
    }
    if (!user) {
      setError("User not logged in");
      return;
    }
    setUploading(true);
    try {
      await uploadDriveFiles(files, currentFolderId);
      setFiles([]);
      void fetchFiles();
    } catch (err) {
      logger.error("Upload error:", err);
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const downloadFile = async (file: UploadedFile) => {
    try {
      setError(null);
      await downloadDriveFile(file.id, file.name);
    } catch (err) {
      logger.error("Download error:", err);
      setError("Download failed.");
    }
  };

  // === Filtering ===
  const visibleFolders = normalizedSearchQuery
    ? folders.filter((f) =>
        f.name.toLowerCase().includes(normalizedSearchQuery),
      )
    : folders;

  const visibleUploadedFiles = normalizedSearchQuery
    ? uploadedFiles.filter((file) =>
        [file.name, file.file_type, file.size.toString(), file.created_at]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery),
      )
    : uploadedFiles;

  return (
    <div className="drive-container">

      {/* 🔹 Breadcrumb + folder actions */}
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
        </div>
      </div>

      {/* 🔹 Upload Section */}
      <div className="upload-section">
        <div className="drive-header">
          <h2>📁 My Drive</h2>
        </div>

        <div
          className="drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <p>Drag & Drop files here</p>
          <span>or</span>

          {files.length > 0 ? (
            <button
              className="upload-btn"
              onClick={uploadFiles}
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
          ) : (
            <label className="browse-btn">
              Upload
              <input
                type="file"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                hidden
              />
            </label>
          )}
        </div>

        {error && <p className="drive-error-msg" style={{ color: 'red', fontSize: '0.9rem' }}>{error}</p>}

        {files.length > 0 && (
          <div className="selected-files">
            <h4>📤 Selected Files</h4>
            <ul>
              {files.map((f, i) => (
                <li key={i}>
                  {f.name} ({formatFileSize(f.size)})
                  <button onClick={() => removeFile(i)}>❌</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 🔹 Folders Section */}
      {(visibleFolders.length > 0 || foldersLoading) && (
        <div className="files-section">
          <h3>📂 Folders</h3>
          {foldersLoading ? (
            <p>Loading folders…</p>
          ) : (
            <div className="file-list">
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
          <p>{normalizedSearchQuery ? "No files match your search" : "No files uploaded yet"}</p>
        ) : (
          <div className="file-list">
            {visibleUploadedFiles.map((file) => (
              <div key={file.id} className="file-row">

                <div className="file-left">
                  <span className="file-icon">
                    {file.file_type === "png" || file.file_type === "jpg"
                      ? "🖼️"
                      : file.file_type === "pdf"
                      ? "📕"
                      : file.file_type === "zip"
                      ? "🗜️"
                      : "📄"}
                  </span>

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
