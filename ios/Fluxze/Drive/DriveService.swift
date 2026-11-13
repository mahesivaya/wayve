import Foundation
import Security

/// One file in Drive (`GET /api/files`).
struct DriveFile: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let fileType: String?
    let size: Int?
    let createdAt: Date?
}

/// One folder in Drive (`GET /api/folders`).
struct DriveFolder: Codable, Identifiable, Hashable {
    let id: Int
    let parentFolderId: Int?
    let name: String
    let createdAt: Date?
}

/// Drive, read through the same endpoints the web app uses. Files are stored
/// end-to-end encrypted (the WV1 envelope); they open on this phone with the
/// key in `KeyVault`.
@MainActor
struct DriveService {
    let api: APIClient

    enum OpenFailure: LocalizedError {
        case locked

        var errorDescription: String? {
            "This file is end-to-end encrypted. Unlock your key on this iPhone to open it."
        }
    }

    /// A folder's subfolders and files; nil is the Drive root.
    func contents(of folderID: Int?) async throws -> (folders: [DriveFolder], files: [DriveFile]) {
        let folderQuery = folderID.map { "?parent_folder_id=\($0)" } ?? ""
        let fileQuery = folderID.map { "?folder_id=\($0)" } ?? ""
        async let folders: [DriveFolder] = api.get("/api/folders\(folderQuery)")
        async let files: [DriveFile] = api.get("/api/files\(fileQuery)")
        return try await (
            folders.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending },
            files.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        )
    }

    /// Downloads a file, decrypts it if it's sealed, and writes it to a temp
    /// file under its own name for Quick Look. Throws `.locked` when it's sealed
    /// and the key isn't on this phone.
    func open(_ file: DriveFile) async throws -> URL {
        let raw = try await api.download("/api/files/\(file.id)/download")
        let bytes: Data
        if FluxzeCrypto.isFileEnvelope(raw) {
            guard let key = KeyVault.privateKey() else { throw OpenFailure.locked }
            bytes = try await Task.detached(priority: .userInitiated) {
                try FluxzeCrypto.openFileEnvelope(raw, key: key)
            }.value
        } else {
            bytes = raw  // a file uploaded before Drive encryption
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("drive-\(file.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(Self.safeName(file.name))
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    func delete(_ file: DriveFile) async throws {
        try await api.delete("/api/files/\(file.id)")
    }

    /// Deletes the folder and everything in it.
    func delete(_ folder: DriveFolder) async throws {
        try await api.delete("/api/folders/\(folder.id)")
    }

    /// The name without path separators, so it can't escape the temp folder.
    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : cleaned
    }

    static func sizeLabel(_ bytes: Int?) -> String? {
        bytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }

    static func icon(for file: DriveFile) -> String {
        switch (file.fileType ?? (file.name as NSString).pathExtension).lowercased() {
        case "pdf": "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "heic", "webp", "svg": "photo"
        case "mp4", "mov", "m4v", "webm": "film"
        case "mp3", "m4a", "wav", "aac": "waveform"
        case "zip", "gz", "tar", "rar", "7z": "doc.zipper"
        case "xls", "xlsx", "csv", "numbers": "tablecells"
        case "ppt", "pptx", "key": "rectangle.on.rectangle"
        case "txt", "md", "rtf", "doc", "docx", "pages": "doc.text"
        default: "doc"
        }
    }
}
