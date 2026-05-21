import { logger } from "../utils/logger";
import { useCallback, useEffect, useState } from "react";
import "./drive.css";
import {
  getDriveFiles,
  uploadDriveFiles,
  downloadDriveFile,
  type UploadedFile,
} from "../api/drive";
import { useAuth } from "../auth/useAuth";
import { useGlobalSearch } from "../search/SearchContext";
import { formatFileSize } from "../emails/renderUtils";

export default function Drive() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();

  const [files, setFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  //
  // ✅ FETCH FILES
  //
  const fetchFiles = useCallback(async () => {
    if (!user) return;

    setLoading(true);
    setError(null);

    try {
      const data = await getDriveFiles();

      logger.log("🔥 API DATA:", data);
      logger.log("👤 USER ID:", user.id);

      setUploadedFiles(Array.isArray(data) ? data : []);
    } catch (err) {
      logger.error("❌ Fetch error:", err);
      setError("Failed to load files.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user?.id) {
      const timer = window.setTimeout(() => {
        void fetchFiles();
      }, 0);

      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [fetchFiles, user?.id]);

  //
  // ✅ HANDLE FILE SELECT
  //
  const handleFiles = (selected: FileList | null) => {
    if (!selected) return;
    setFiles((prev) => [...prev, ...Array.from(selected)]);
  };

  //
  // ✅ DRAG DROP
  //
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  //
  // ❌ REMOVE FILE FROM SELECTION (UX IMPROVEMENT)
  //
  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  //
  // ✅ UPLOAD FILES
  //
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
      await uploadDriveFiles(files);

      logger.log("✅ Upload success");

      setFiles([]);
      void fetchFiles(); // refresh list
    } catch (err) {
      logger.error("❌ Upload error:", err);
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  //
  // ✅ DOWNLOAD FILE (authenticated route)
  //
  const downloadFile = async (file: UploadedFile) => {
    try {
      setError(null);
      await downloadDriveFile(file.id, file.name);
    } catch (err) {
      logger.error("❌ Download error:", err);
      setError("Download failed.");
    }
  };

  const visibleUploadedFiles = normalizedSearchQuery
    ? uploadedFiles.filter((file) =>
        [file.name, file.file_type, file.size.toString(), file.created_at]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearchQuery)
      )
    : uploadedFiles;

  return (
    <div className="drive-container">

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
