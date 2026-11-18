import QuickLook
import SwiftUI

/// The Drive tab: the same folders and files as Drive on the web.
struct DriveView: View {
    let api: APIClient
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            DriveFolderView(service: DriveService(api: api), folder: nil)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .navigationDestination(for: DriveFolder.self) { folder in
                    DriveFolderView(service: DriveService(api: api), folder: folder)
                }
        }
    }
}

/// One folder's subfolders and files; `folder` nil is the Drive root.
struct DriveFolderView: View {
    let service: DriveService
    let folder: DriveFolder?

    @State private var folders: [DriveFolder] = []
    @State private var files: [DriveFile] = []
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var opening: Int?
    @State private var preview: URL?
    @State private var unlocking = false
    @State private var actionError: String?
    @State private var pendingFileDelete: DriveFile?
    @State private var pendingFolderDelete: DriveFolder?

    var body: some View {
        content
            // No title at the Drive root; a folder shows its name.
            .navigationTitle(folder?.name ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load() }
            .task { if !hasLoaded { await load() } }
            .quickLookPreview($preview)
            .onChange(of: preview) { old, new in
                // Decrypted copies don't outlive their preview.
                if new == nil, let old { try? FileManager.default.removeItem(at: old.deletingLastPathComponent()) }
            }
            .sheet(isPresented: $unlocking) { UnlockKeyView() }
            .confirmationDialog(
                "Delete this file?",
                isPresented: Binding(get: { pendingFileDelete != nil }, set: { if !$0 { pendingFileDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingFileDelete
            ) { file in
                Button("Delete", role: .destructive) { run { try await service.delete(file); files.removeAll { $0.id == file.id } } }
            } message: { file in
                Text(file.name)
            }
            .confirmationDialog(
                "Delete this folder and everything in it?",
                isPresented: Binding(get: { pendingFolderDelete != nil }, set: { if !$0 { pendingFolderDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingFolderDelete
            ) { folder in
                Button("Delete", role: .destructive) { run { try await service.delete(folder); folders.removeAll { $0.id == folder.id } } }
            } message: { folder in
                Text(folder.name)
            }
            .alert("Something went wrong",
                   isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                if actionError == DriveService.OpenFailure.locked.errorDescription {
                    Button("Unlock with recovery phrase") { unlocking = true }
                }
                Button("OK", role: .cancel) {}
            } message: {
                Text(actionError ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            ProgressView()
        } else if folders.isEmpty, files.isEmpty, let loadError {
            ContentUnavailableView {
                Label("Couldn't load Drive", systemImage: "wifi.exclamationmark")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try again") { Task { await load() } }
            }
        } else if folders.isEmpty, files.isEmpty {
            ContentUnavailableView(
                folder == nil ? "Drive is empty" : "This folder is empty",
                systemImage: "folder",
                description: Text("Upload files in Hadal on the web, and they show up here.")
            )
        } else {
            List {
                ForEach(folders) { item in
                    NavigationLink(value: item) {
                        Label(item.name, systemImage: "folder.fill")
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { pendingFolderDelete = item }
                    }
                }
                ForEach(files) { file in
                    Button { open(file) } label: { FileRow(file: file, isOpening: opening == file.id) }
                        .buttonStyle(.plain)
                        .disabled(opening != nil)
                        .swipeActions {
                            Button("Delete", role: .destructive) { pendingFileDelete = file }
                        }
                }
            }
            .listStyle(.plain)
        }
    }

    private func load() async {
        do {
            (folders, files) = try await service.contents(of: folder?.id)
            loadError = nil
        } catch APIError.unauthorized {
            // AppState signs out.
        } catch {
            loadError = error.localizedDescription
        }
        hasLoaded = true
    }

    private func open(_ file: DriveFile) {
        opening = file.id
        Task {
            defer { opening = nil }
            do {
                preview = try await service.open(file)
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { actionError = error.localizedDescription }
        }
    }
}

private struct FileRow: View {
    let file: DriveFile
    let isOpening: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: DriveService.icon(for: file))
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).lineLimit(2)
                Text([DriveService.sizeLabel(file.size),
                      file.createdAt?.formatted(date: .abbreviated, time: .omitted)]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if isOpening { ProgressView() }
        }
        .contentShape(Rectangle())
    }
}
