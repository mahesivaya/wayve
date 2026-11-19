import SwiftUI

/// The Reviews tab: pull requests across every repository you can see, as on
/// the web's Code & reviews. Created by you, waiting for your review, or all
/// of them; open ones first, then merged, then closed.
struct ReviewsView: View {
    /// Owned by MainTabView, which also watches it for new pull requests.
    @ObservedObject var store: ReviewsStore
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            content
                // No title: the tab already says Reviews.
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { repoMenu }
                    // The account button stands apart, in its own glass bubble.
                    if #available(iOS 26.0, *) {
                        ToolbarSpacer(.fixed, placement: .topBarTrailing)
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
            Image(systemName: "slider.horizontal.3")
                .symbolVariant(store.repoFilter == nil ? .none : .circle.fill)
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
                description: Text("Connect GitHub in Hadal on the web, and your pull requests show up here.")
            )
        } else if store.repos.isEmpty {
            ContentUnavailableView(
                "No repositories",
                systemImage: "folder",
                description: Text("Pull requests show up here for repositories linked to a project in Hadal. Link one on the web.")
            )
        } else {
            List {
                // Created / To review need your own GitHub login to tell
                // which pull requests are yours; without it there's only All.
                if store.login != nil {
                    scopeTabs
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                }
                if store.shown.isEmpty {
                    ContentUnavailableView {
                        Label("No pull requests", image: "PullRequest")
                    } description: {
                        Text(emptyText)
                    }
                    .listRowSeparator(.hidden)
                } else {
                    group("Open", store.open)
                    group("Merged", store.merged)
                    group("Closed", store.closed)
                }
                if !store.skipped.isEmpty {
                    Text("Couldn't read \(store.skipped.count == 1 ? store.skipped[0] : "\(store.skipped.count) repositories").")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .contentMargins(.top, 0, for: .scrollContent)
            // Rows take only the height they need.
            .environment(\.defaultMinListRowHeight, 0)
        }
    }

    private var emptyText: String {
        switch store.scope {
        case .created: "You haven't opened any here."
        case .toReview: "Nothing is waiting for your review."
        case .all: store.repoFilter?.fullName ?? "Across \(store.repos.count) repositories"
        }
    }

    /// Created · To review · All, as pills; the chosen one is outlined.
    private var scopeTabs: some View {
        HStack(spacing: 4) {
            ForEach(ReviewsStore.Scope.allCases) { scope in
                let chosen = store.scope == scope
                Button { store.scope = scope } label: {
                    Text(scope.rawValue)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(chosen ? .primary : .secondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background {
                            if chosen {
                                Capsule().fill(Color(.secondarySystemBackground))
                                Capsule().strokeBorder(Color(.separator), lineWidth: 0.5)
                            }
                        }
                        .contentShape(Capsule())
                }
                // Borderless, so each pill takes its own tap inside the row.
                .buttonStyle(.borderless)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
            Spacer()
        }
    }

    /// A grey heading, then its pull requests; nothing when there are none.
    @ViewBuilder
    private func group(_ title: String, _ items: [ReviewItem]) -> some View {
        if !items.isEmpty {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .listRowInsets(EdgeInsets(top: 14, leading: 16, bottom: 4, trailing: 16))
                .listRowSeparator(.hidden)
                .accessibilityAddTraits(.isHeader)
            ForEach(items) { item in
                PullRequestRow(item: item, checks: store.checks[item.id])
                    // The whole row opens the pull request, without the list's › .
                    .background(NavigationLink(value: item) { EmptyView() }.opacity(0))
                    .listRowInsets(EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
                    .listRowSeparator(.hidden)
                    .task {
                        if item.status == .open || item.status == .draft { await store.loadChecks(for: item) }
                    }
            }
        }
    }
}

/// One line: the status icon, the title, the checks of an open pull request,
/// and who opened it.
private struct PullRequestRow: View {
    let item: ReviewItem
    let checks: CheckSummary?

    var body: some View {
        HStack(spacing: 12) {
            StatusIcon(status: item.status, size: 20)
            Text(item.pr.title)
                .font(.body)
                .lineLimit(1)
            Spacer(minLength: 4)
            if item.status == .draft {
                Text("Draft")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color(.tertiarySystemFill), in: Capsule())
            }
            if let checks, checks.outcome != nil { ChecksIcon(summary: checks) }
            AuthorAvatar(login: item.pr.user?.login ?? "?")
        }
        .contentShape(Rectangle())
    }
}

/// A checklist, coloured by how the checks went: green passed, red failing,
/// grey still running.
struct ChecksIcon: View {
    let summary: CheckSummary

    var body: some View {
        Image(systemName: "checklist")
            .font(.subheadline)
            .foregroundStyle(Self.color(summary.outcome))
            .accessibilityLabel("Checks: \(summary.label)")
    }

    static func color(_ outcome: CheckRun.Outcome?) -> Color {
        switch outcome {
        case .pass: StatusIcon.green
        case .fail: .red
        default: .secondary
        }
    }
}

/// Who, as two letters on a coloured disc (the web's `PrAvatar`).
struct AuthorAvatar: View {
    let login: String
    var size: CGFloat = 26

    var body: some View {
        Text(Self.initials(login))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Self.color(login), in: Circle())
            .accessibilityLabel(login)
    }

    /// "mahesivaya" → "MA"; "dependabot[bot]" → "DE".
    static func initials(_ login: String) -> String {
        let letters = login.filter { $0.isLetter || $0.isNumber }
        return letters.isEmpty ? "?" : String(letters.prefix(2)).uppercased()
    }

    static let palette: [Color] = [.purple, .blue, .teal, .indigo, .pink, .orange, .brown, .mint]

    /// The same colour for the same person every time.
    static func color(_ login: String) -> Color {
        let sum = login.lowercased().unicodeScalars.reduce(0) { ($0 &+ Int($1.value)) % 1_000_003 }
        return palette[sum % palette.count]
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
