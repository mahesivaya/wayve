import SwiftUI

/// The Reviews tab: pull requests across every repository you can see, as on
/// the web's Code & reviews. Open ones, then closed ones, on one page; all
/// repositories or one.
struct ReviewsView: View {
    @StateObject var store: ReviewsStore
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { repoMenu }
                    ToolbarItem(placement: .principal) {
                        Text("Reviews").font(.headline)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .navigationDestination(for: ReviewItem.self) { PullRequestDetailView(item: $0, api: store.api) }
        }
        .task { if !store.hasLoaded { await store.load() } }
    }

    /// Narrows the list to one repository.
    private var repoMenu: some View {
        Menu {
            Button { store.repoFilter = nil } label: {
                Label("All repositories", systemImage: store.repoFilter == nil ? "checkmark" : "square.stack.3d.up")
            }
            if !store.repos.isEmpty {
                Section {
                    ForEach(store.repos) { repo in
                        Button { store.repoFilter = repo } label: {
                            Label(repo.fullName, systemImage: store.repoFilter == repo ? "checkmark" : "folder")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: store.repoFilter == nil
                  ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Repositories")
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasLoaded || (store.isLoading && store.items.isEmpty) {
            ProgressView()
        } else if let error = store.errorMessage, store.items.isEmpty {
            ContentUnavailableView {
                Label("Couldn't load pull requests", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await store.load() } }
            }
        } else if store.notConnected {
            ContentUnavailableView(
                "GitHub isn't connected",
                systemImage: "link",
                description: Text("Connect GitHub in Fluxze on the web, and your pull requests show up here.")
            )
        } else if store.repos.isEmpty {
            ContentUnavailableView(
                "No repositories",
                systemImage: "folder",
                description: Text("Pull requests show up here for repositories linked to a project in Fluxze. Link one on the web.")
            )
        } else if store.shown.isEmpty {
            ContentUnavailableView {
                Label("No pull requests", image: "PullRequest")
            } description: {
                Text(store.repoFilter?.fullName ?? "Across \(store.repos.count) repositories")
            }
        } else {
            // Open pull requests at the top, then closed ones. No line between
            // rows; one thin line between the two groups is the only break.
            List {
                rows(store.open)
                if !store.open.isEmpty, !store.closed.isEmpty {
                    Rectangle()
                        .fill(Color(.separator))
                        .frame(height: 0.5)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                        .accessibilityHidden(true)
                }
                rows(store.closed)
                if !store.skipped.isEmpty {
                    Text("Couldn't read \(store.skipped.count == 1 ? store.skipped[0] : "\(store.skipped.count) repositories").")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .contentMargins(.top, 0, for: .scrollContent)
            // Rows take only the height they need, so the dividing line's row
            // is just the line, not a full 44pt row.
            .environment(\.defaultMinListRowHeight, 0)
        }
    }
}

extension ReviewsView {
    fileprivate func rows(_ items: [ReviewItem]) -> some View {
        ForEach(items) { item in
            NavigationLink(value: item) { PullRequestRow(item: item) }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .listRowSeparator(.hidden)
        }
    }
}

private struct PullRequestRow: View {
    let item: ReviewItem

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusIcon(status: item.status)
                .padding(.top, 2)
            // The title on one line, who and when under it.
            VStack(alignment: .leading, spacing: 2) {
                Text(item.pr.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let author = item.pr.user?.login { Text(author) }
                    if let date = item.pr.updatedAt ?? item.pr.createdAt {
                        Text("·")
                        Text(date.formatted(.relative(presentation: .named)))
                    }
                    if item.status == .draft {
                        Text("Draft")
                            .padding(.horizontal, 5)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
    }
}

/// GitHub's pull request icons (Lucide's, as on the web): open (drafts too)
/// in green, merged and closed in purple.
struct StatusIcon: View {
    let status: ReviewItem.Status
    var size: CGFloat = 18

    var body: some View {
        Image(Self.asset(for: status))
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(Self.color(for: status))
            .accessibilityLabel(status.rawValue)
    }

    static func asset(for status: ReviewItem.Status) -> String {
        switch status {
        case .open, .draft: "PullRequest"
        case .merged: "PullRequestMerged"
        case .closed: "PullRequestClosed"
        }
    }

    /// GitHub's open green and done purple, brighter in dark mode as there.
    static let green = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x3f / 255, green: 0xb9 / 255, blue: 0x50 / 255, alpha: 1)
        : UIColor(red: 0x1a / 255, green: 0x7f / 255, blue: 0x37 / 255, alpha: 1) })
    static let purple = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0xa3 / 255, green: 0x71 / 255, blue: 0xf7 / 255, alpha: 1)
        : UIColor(red: 0x82 / 255, green: 0x50 / 255, blue: 0xdf / 255, alpha: 1) })

    static func color(for status: ReviewItem.Status) -> Color {
        switch status {
        case .open, .draft: green
        case .merged, .closed: purple
        }
    }
}

/// One pull request, with Overview and Code at the top: Overview (the
/// default) is who, where and the description; Code lists the changed files.
struct PullRequestDetailView: View {
    let item: ReviewItem
    let api: APIClient

    enum Tab: String, CaseIterable, Identifiable {
        case overview = "Overview", code = "Code"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .overview

    var body: some View {
        Group {
            switch tab {
            case .overview: overview
            case .code: PullRequestFilesView(item: item, api: api)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
            }
        }
    }

    private var overview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(item.pr.title)
                    .font(.title3.weight(.semibold))
                HStack(spacing: 8) {
                    StatusIcon(status: item.status)
                    Text(item.status.rawValue).font(.subheadline.weight(.medium))
                    Text("\(item.repo.fullName) #\(item.pr.number)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if let author = item.pr.user?.login {
                        LabeledContent("Author", value: author)
                    }
                    if let head = item.pr.head?.ref, let base = item.pr.base?.ref {
                        LabeledContent("Branch", value: "\(head) → \(base)")
                    }
                    if let created = item.pr.createdAt {
                        LabeledContent("Opened", value: created.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let merged = item.pr.mergedAt {
                        LabeledContent("Merged", value: merged.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                .font(.subheadline)

                Divider()

                if let body = item.pr.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
                    Text(Self.markdown(body))
                        .font(.body)
                        .textSelection(.enabled)
                } else {
                    Text("No description.")
                        .foregroundStyle(.secondary)
                }

                Link(destination: item.pr.htmlUrl) {
                    Label("Open on GitHub", systemImage: "arrow.up.right.square")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .padding(.top, 8)
            }
            .padding()
        }
    }

    /// GitHub-flavoured Markdown as far as iOS renders it (bold, links, code,
    /// lists keep their lines); falls back to the raw text.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

/// Code: every file the pull request touches, with its added and removed
/// line counts. Tapping one shows its diff.
struct PullRequestFilesView: View {
    let item: ReviewItem
    let api: APIClient

    @State private var files: [PullFile]?
    @State private var errorMessage: String?
    /// Files whose diff is open under their row.
    @State private var expanded: Set<String> = []

    var body: some View {
        Group {
            if let files {
                if files.isEmpty {
                    ContentUnavailableView("No changed files", systemImage: "doc")
                } else {
                    List {
                        Section {
                            ForEach(files) { file in
                                // Tapping a file opens its diff right under it, on
                                // this screen; tapping again closes it.
                                VStack(alignment: .leading, spacing: 8) {
                                    Button {
                                        withAnimation(.easeInOut(duration: 0.2)) {
                                            if expanded.contains(file.id) { expanded.remove(file.id) } else { expanded.insert(file.id) }
                                        }
                                    } label: {
                                        PullFileRow(file: file, isExpanded: expanded.contains(file.id))
                                    }
                                    .buttonStyle(.plain)
                                    if expanded.contains(file.id) {
                                        PullFileDiffView(file: file)
                                    }
                                }
                                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                                // No lines between rows, as in the pull request list.
                                .listRowSeparator(.hidden)
                            }
                        } header: {
                            summary(files)
                        }
                    }
                    .listStyle(.plain)
                }
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("Couldn't load the changes", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .task { if files == nil { await load() } }
        .refreshable { await load() }
    }

    /// "12 files  +340  −25", as GitHub's Files changed tab.
    private func summary(_ files: [PullFile]) -> some View {
        HStack(spacing: 8) {
            Text("\(files.count) \(files.count == 1 ? "file" : "files")")
            Text("+\(files.reduce(0) { $0 + $1.additions })").foregroundStyle(StatusIcon.green)
            Text("−\(files.reduce(0) { $0 + $1.deletions })").foregroundStyle(.red)
        }
        .font(.caption.weight(.semibold))
        .textCase(nil)
    }

    private func load() async {
        do {
            files = try await ReviewsStore.files(of: item, api: api)
            errorMessage = nil
        } catch {
            errorMessage = ReviewsStore.describe(error)
        }
    }
}

struct PullFileRow: View {
    let file: PullFile
    let isExpanded: Bool

    var body: some View {
        // Laid out like a pull request row: an 18pt icon, the name in the
        // same type, the path under it in small grey.
        HStack(alignment: .top, spacing: 10) {
            FileTypeIcon(path: file.filename)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text((file.filename as NSString).lastPathComponent)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                // The folder only (the name is the line above), cut in the
                // middle when long so both ends stay readable.
                if let detail = Self.detail(file) {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                Text("+\(file.additions)").foregroundStyle(StatusIcon.green)
                Text("−\(file.deletions)").foregroundStyle(.red)
            }
            .font(.caption.monospacedDigit())
            .padding(.top, 3)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .padding(.top, 4)
        }
        .contentShape(Rectangle())
        .accessibilityHint(isExpanded ? "Hides the diff" : "Shows the diff")
    }

    /// "backend/crates/wayve-server/src/email/", or what a rename came from;
    /// nil for a file at the top of the repository.
    static func detail(_ file: PullFile) -> String? {
        if let old = file.previousFilename, old != file.filename {
            return "Renamed from \(old)"
        }
        return folder(of: file.filename)
    }

    static func folder(of path: String) -> String? {
        guard let slash = path.lastIndex(of: "/") else { return nil }
        return String(path[...slash])
    }
}

/// One file's diff, shown under its row: added lines green, removed lines
/// red, hunk headers blue. Scrolls sideways for long lines rather than
/// wrapping code; the list scrolls it up and down.
struct PullFileDiffView: View {
    let file: PullFile

    var body: some View {
        Group {
            if let patch = file.patch, !patch.isEmpty {
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(patch.split(separator: "\n", omittingEmptySubsequences: false).enumerated()),
                                id: \.offset) { _, line in
                            let kind = Self.kind(of: line)
                            Text(line.isEmpty ? " " : String(line))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(kind == .hunk ? Color.blue : Color.primary)
                                .padding(.horizontal, 8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Self.background(kind))
                        }
                    }
                    .padding(.vertical, 6)
                    .textSelection(.enabled)
                }
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            } else {
                Text("No diff to show. GitHub doesn't show one for binary or very large files.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    enum Kind { case added, removed, hunk, context }

    static func kind<S: StringProtocol>(of line: S) -> Kind {
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    static func background(_ kind: Kind) -> Color {
        switch kind {
        case .added: StatusIcon.green.opacity(0.15)
        case .removed: Color.red.opacity(0.15)
        case .hunk: Color.blue.opacity(0.08)
        case .context: .clear
        }
    }
}

/// A file's language logo, picked from its name as on the web
/// (`frontend/src/github/FileTypeIcon.tsx`), drawn in grey. Logos are Simple
/// Icons (CC0) in Assets.xcassets/FileTypes; other kinds use SF Symbols.
struct FileTypeIcon: View {
    let path: String
    var size: CGFloat = 18

    var body: some View {
        let kind = Self.kind(for: path)
        Group {
            switch kind.icon {
            case .logo(let name): Image("FileTypes/\(name)").resizable()
            case .symbol(let name): Image(systemName: name).resizable()
            }
        }
        .scaledToFit()
        .frame(width: size, height: size)
        .foregroundStyle(.secondary)
        .accessibilityLabel(kind.label)
    }

    enum Icon: Equatable {
        /// An image in Assets.xcassets/FileTypes.
        case logo(String)
        case symbol(String)
    }

    struct Kind: Equatable {
        let label: String
        let icon: Icon
    }

    private static func logo(_ label: String, _ name: String) -> Kind { Kind(label: label, icon: .logo(name)) }
    private static func symbol(_ label: String, _ name: String) -> Kind { Kind(label: label, icon: .symbol(name)) }

    static let byExtension: [String: Kind] = {
        let config = { symbol($0, "gearshape") }
        let image = symbol("Image", "photo")
        let shell = logo("Shell script", "gnubash")
        return [
            "tsx": logo("TypeScript React", "react"), "jsx": logo("JavaScript React", "react"),
            "ts": logo("TypeScript", "typescript"), "mts": logo("TypeScript", "typescript"),
            "js": logo("JavaScript", "javascript"), "mjs": logo("JavaScript", "javascript"),
            "cjs": logo("JavaScript", "javascript"),
            "rs": logo("Rust", "rust"), "py": logo("Python", "python"), "go": logo("Go", "go"),
            "rb": logo("Ruby", "ruby"), "php": logo("PHP", "php"),
            "c": logo("C", "c"), "h": logo("C header", "c"), "cpp": logo("C++", "cplusplus"),
            "hpp": logo("C++ header", "cplusplus"), "cc": logo("C++", "cplusplus"),
            "swift": logo("Swift", "swift"), "kt": logo("Kotlin", "kotlin"), "kts": logo("Kotlin", "kotlin"),
            "java": symbol("Java", "chevron.left.forwardslash.chevron.right"),
            "json": logo("JSON", "json"),
            "css": logo("Stylesheet", "css"), "scss": logo("Sass", "sass"), "sass": logo("Sass", "sass"),
            "html": logo("HTML", "html5"), "htm": logo("HTML", "html5"),
            "xml": symbol("XML", "chevron.left.forwardslash.chevron.right"),
            "md": logo("Markdown", "markdown"), "mdx": logo("Markdown", "markdown"),
            "txt": symbol("Text", "doc.text"),
            "sql": logo("SQL", "postgresql"),
            "sh": shell, "bash": shell, "zsh": shell,
            "yml": logo("YAML", "yaml"), "yaml": logo("YAML", "yaml"), "toml": logo("TOML", "toml"),
            "ini": config("Config"), "env": config("Environment"), "conf": config("Config"),
            "lock": symbol("Lock file", "lock"),
            "png": image, "jpg": image, "jpeg": image, "gif": image, "webp": image, "svg": image, "ico": image,
        ]
    }()

    /// Names that say more than their extension, or have none, come first.
    static func kind(for path: String) -> Kind {
        let name = (path.split(separator: "/").last.map(String.init) ?? path).lowercased()
        if name == "dockerfile" || name.hasPrefix("dockerfile.") || name.hasPrefix("docker-compose") {
            return logo("Dockerfile", "docker")
        }
        if name == "justfile" || name == "makefile" { return logo("Shell script", "gnubash") }
        if name == "package-lock.json" { return symbol("Lock file", "lock") }
        if name == ".env" || name.hasPrefix(".env.") { return symbol("Environment", "gearshape") }
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex || name.count > 1 else {
            return symbol("File", "doc")
        }
        return byExtension[String(name[name.index(after: dot)...])] ?? symbol("File", "doc")
    }
}
