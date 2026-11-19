import SwiftUI

/// One pull request, as on the web. Overview: the title and who, a table of
/// its status, reviewers, checks, approvals and branch, the description and
/// the conversation, with a comment box at the bottom. Diff: the changed
/// files, each opening to its diff.
struct PullRequestDetailView: View {
    let item: ReviewItem
    let api: APIClient

    enum Tab { case overview, diff }

    @State private var tab: Tab = .overview
    @State private var bundle: PullBundle?
    @State private var errorMessage: String?
    /// Files whose diff is open under their row.
    @State private var expanded: Set<String> = []
    @State private var showingChecks = false
    @State private var draft = ""
    @State private var isSending = false
    @State private var sendError: String?
    @FocusState private var writing: Bool

    var body: some View {
        Group {
            if let bundle {
                page(bundle)
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("Couldn't load this pull request", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Link(destination: item.pr.htmlUrl) { Image(systemName: "arrow.up.right.square") }
                    .accessibilityLabel("Open on GitHub")
            }
        }
        .task { if bundle == nil { await load() } }
        .refreshable { await load() }
        .alert("Couldn't post the comment", isPresented: Binding(
            get: { sendError != nil }, set: { if !$0 { sendError = nil } })
        ) {
            Button("OK", role: .cancel) { sendError = nil }
        } message: {
            Text(sendError ?? "")
        }
    }

    private func load() async {
        do {
            bundle = try await ReviewsStore.bundle(of: item, api: api)
            errorMessage = nil
        } catch {
            if bundle == nil { errorMessage = ReviewsStore.describe(error) }
        }
    }

    private func page(_ bundle: PullBundle) -> some View {
        let pr = bundle.detail
        let shown = ReviewItem(repo: item.repo, pr: pr)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                tabs(bundle)
                switch tab {
                case .overview:
                    Text(pr.title)
                        .font(.title.weight(.bold))
                        .textSelection(.enabled)
                    byline(pr)
                    table(shown, bundle)
                    description(pr)
                    conversation(ReviewsStore.timeline(comments: bundle.comments, reviews: bundle.reviews))
                case .diff:
                    files(bundle.files)
                }
            }
            .padding(.horizontal)
            .padding(.bottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            if tab == .overview { commentBar }
        }
    }

    // MARK: Overview · Diff

    private func tabs(_ bundle: PullBundle) -> some View {
        let pr = bundle.detail
        let added = pr.additions ?? bundle.files.reduce(0) { $0 + $1.additions }
        let removed = pr.deletions ?? bundle.files.reduce(0) { $0 + $1.deletions }
        return HStack(spacing: 4) {
            pill(.overview) { Text("Overview") }
            pill(.diff) {
                HStack(spacing: 6) {
                    Text("Diff")
                    Text("+\(added)").foregroundStyle(StatusIcon.green)
                    Text("-\(removed)").foregroundStyle(.red)
                }
                .monospacedDigit()
            }
            Spacer()
        }
        .padding(.leading, -4)
    }

    private func pill<Label: View>(_ which: Tab, @ViewBuilder label: () -> Label) -> some View {
        let chosen = tab == which
        return Button { tab = which } label: {
            label()
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
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    // MARK: Who and where

    /// One line that scrolls sideways: who · repo#number · base ← head.
    private func byline(_ pr: PullRequest) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                AuthorAvatar(login: pr.user?.login ?? "?", size: 22)
                Text(pr.user?.login ?? "unknown").foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
                Link(destination: pr.htmlUrl) { Chip(text: "\(item.repo.fullName)#\(pr.number)") }
                    .buttonStyle(.plain)
                if let head = pr.head?.ref, let base = pr.base?.ref {
                    Text("·").foregroundStyle(.tertiary)
                    // Where it goes, then where it comes from, as on the web.
                    Chip(text: base)
                    Image(systemName: "arrow.left").font(.caption2).foregroundStyle(.secondary)
                    Chip(text: head)
                }
            }
            .font(.subheadline)
        }
    }

    // MARK: Status, reviewers, checks, approvals, branch

    private func table(_ shown: ReviewItem, _ bundle: PullBundle) -> some View {
        let pr = bundle.detail
        let reviewers = (pr.requestedReviewers ?? []).map(\.login)
        let checks = bundle.checkRuns.map(CheckSummary.init)
        let verdicts = ReviewsStore.verdicts(bundle.reviews)
        let blocked = verdicts.contains { !$0.approved }
        let branch = ReviewsStore.branchState(shown)
        let runs = (bundle.checkRuns ?? []).sorted {
            $0.outcome == $1.outcome ? $0.name.localizedStandardCompare($1.name) == .orderedAscending
                                     : $0.outcome.rawValue < $1.outcome.rawValue
        }
        return VStack(spacing: 0) {
            MetaRow(label: "Status") {
                StatusIcon(status: shown.status, size: 18)
                Text(shown.status.rawValue)
            }
            Divider()
            MetaRow(label: "Reviewers") {
                Image(systemName: "person.2").foregroundStyle(.secondary)
                Text(reviewers.isEmpty ? "None requested" : reviewers.joined(separator: ", "))
                    .foregroundStyle(reviewers.isEmpty ? .secondary : .primary)
            }
            Divider()
            // Tapping Checks lists each one under the row.
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showingChecks.toggle() }
            } label: {
                MetaRow(label: "Checks") {
                    Image(systemName: "checklist").foregroundStyle(.secondary)
                    if let checks, checks.total > 0 {
                        Text("\(checks.passed) / \(checks.total) passed")
                        if checks.failing > 0 {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                            Text("\(checks.failing) failed")
                        } else if checks.pending > 0 {
                            Image(systemName: "clock").foregroundStyle(.secondary)
                            Text("\(checks.pending) running")
                        }
                    } else {
                        Text(checks == nil ? "Unavailable" : "No checks").foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(runs.isEmpty)
            if showingChecks {
                VStack(spacing: 0) {
                    ForEach(runs) { run in
                        HStack(spacing: 10) {
                            Image(systemName: Self.symbol(run.outcome))
                                .font(.caption)
                                .foregroundStyle(run.outcome == .skip ? Color.secondary : ChecksIcon.color(run.outcome))
                                .frame(width: 18)
                            Text(run.name).font(.footnote).lineLimit(1)
                            Spacer()
                        }
                        .padding(.vertical, 5)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            Divider()
            MetaRow(label: "Approvals") {
                Image(systemName: blocked ? "exclamationmark.bubble" : "checkmark.seal")
                    .foregroundStyle(blocked ? Color.red : verdicts.isEmpty ? Color.secondary : StatusIcon.green)
                Text(Self.approvalsLabel(verdicts))
                    .foregroundStyle(verdicts.isEmpty ? .secondary : .primary)
            }
            Divider()
            MetaRow(label: "Branch") {
                Image(branch == "Conflicts" ? "PullRequestClosed" : StatusIcon.asset(for: shown.status))
                    .resizable().scaledToFit().frame(width: 18, height: 18)
                    .foregroundStyle(branch == "Conflicts" ? Color.red : Color.secondary)
                Text(branch)
            }
        }
        .font(.subheadline)
        .background(Color(.secondarySystemBackground).opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5))
    }

    static func symbol(_ outcome: CheckRun.Outcome?) -> String {
        switch outcome {
        case .pass: "checkmark.circle.fill"
        case .fail: "xmark.circle.fill"
        case .pending: "clock"
        case .skip: "minus.circle"
        case nil: "circle.dashed"
        }
    }

    /// "Approved by ana", "Changes requested by bo", "No approvals yet".
    static func approvalsLabel(_ verdicts: [Verdict]) -> String {
        let blocking = verdicts.filter { !$0.approved }.map(\.login)
        if !blocking.isEmpty { return "Changes requested by \(blocking.joined(separator: ", "))" }
        let approving = verdicts.map(\.login)
        return approving.isEmpty ? "No approvals yet" : "Approved by \(approving.joined(separator: ", "))"
    }

    // MARK: Description

    @ViewBuilder
    private func description(_ pr: PullRequest) -> some View {
        if let body = pr.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
            MarkdownText(text: body)
        } else {
            Text("No description.").foregroundStyle(.secondary)
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

    // MARK: Diff

    @ViewBuilder
    private func files(_ files: [PullFile]) -> some View {
        if files.isEmpty {
            ContentUnavailableView("No changed files", systemImage: "doc")
        }
        ForEach(files) { file in
            // Tapping a file opens its diff right under it; again closes it.
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if expanded.contains(file.id) { expanded.remove(file.id) } else { expanded.insert(file.id) }
                    }
                } label: {
                    PullFileRow(file: file, isExpanded: expanded.contains(file.id))
                }
                .buttonStyle(.plain)
                if expanded.contains(file.id) { PullFileDiffView(file: file) }
            }
        }
    }

    // MARK: Conversation

    @ViewBuilder
    private func conversation(_ entries: [TimelineEntry]) -> some View {
        if !entries.isEmpty {
            Divider()
            ForEach(entries) { entry in
                HStack(alignment: .top, spacing: 10) {
                    AuthorAvatar(login: entry.author, size: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(entry.author).fontWeight(.medium)
                            if let state = entry.reviewState, let label = Self.reviewLabel(state) {
                                Text(label)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(state == "APPROVED" ? StatusIcon.green
                                                     : state == "CHANGES_REQUESTED" ? Color.red : Color.secondary)
                            }
                            if let date = entry.date {
                                Text(date.formatted(.relative(presentation: .named)))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .font(.subheadline)
                        .lineLimit(1)
                        if !entry.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            MarkdownText(text: entry.body, font: .subheadline)
                        }
                    }
                }
            }
        }
    }

    // MARK: Comment

    /// The box at the bottom of Overview: write a comment, send it.
    private var commentBar: some View {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return HStack(alignment: .bottom, spacing: 8) {
            TextField("Comment", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($writing)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
            if !text.isEmpty || isSending {
                Button { Task { await send(text) } } label: {
                    if isSending {
                        ProgressView().frame(width: 34, height: 34)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
                    }
                }
                .disabled(isSending)
                .accessibilityLabel("Post comment")
                .padding(.bottom, 4)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send(_ text: String) async {
        guard !text.isEmpty, !isSending else { return }
        isSending = true
        defer { isSending = false }
        do {
            let posted = try await ReviewsStore.comment(on: item, body: text, api: api)
            bundle = bundle?.adding(posted)
            draft = ""
            writing = false
        } catch {
            sendError = ReviewsStore.describe(error)
        }
    }

    static func reviewLabel(_ state: String) -> String? {
        switch state {
        case "APPROVED": "approved"
        case "CHANGES_REQUESTED": "requested changes"
        case "DISMISSED": "review dismissed"
        default: nil
        }
    }
}

/// A repository or branch name, in code type on a soft chip.
private struct Chip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// "Status   ⌥ Open": a grey label in a fixed column, then an icon and value.
private struct MetaRow<Value: View>: View {
    let label: String
    @ViewBuilder let value: Value

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)
            value
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }
}

/// A description or comment, with the Markdown that matters on GitHub laid
/// out: headings, bullet and numbered lists, and code blocks. Bold, links and
/// inline code come from iOS's own inline Markdown.
struct MarkdownText: View {
    let text: String
    var font: Font = .body

    enum Block: Equatable {
        case heading(String)
        /// The marker to draw ("•" or "1."), then the text.
        case item(String, String)
        case code(String)
        case paragraph(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let title):
                    Text(PullRequestDetailView.markdown(title))
                        .font(font == .body ? .title3.weight(.semibold) : .subheadline.weight(.semibold))
                        .padding(.top, 4)
                case .item(let marker, let line):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).foregroundStyle(.secondary)
                        Text(PullRequestDetailView.markdown(line))
                    }
                    .padding(.leading, 8)
                case .code(let code):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code).font(.system(.footnote, design: .monospaced)).padding(10)
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                case .paragraph(let lines):
                    Text(PullRequestDetailView.markdown(lines))
                }
            }
        }
        .font(font)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func blocks(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
            } else if code != nil {
                code?.append(line)
            } else if trimmed.isEmpty {
                flush()
            } else if trimmed.hasPrefix("#"), let space = trimmed.firstIndex(of: " "),
                      trimmed[..<space].allSatisfy({ $0 == "#" }), trimmed[..<space].count <= 6 {
                flush()
                blocks.append(.heading(String(trimmed[trimmed.index(after: space)...])))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                flush()
                blocks.append(.item("•", String(trimmed.dropFirst(2))))
            } else if let dot = trimmed.firstIndex(of: "."), dot != trimmed.startIndex,
                      trimmed[..<dot].allSatisfy(\.isNumber), trimmed[dot...].hasPrefix(". ") {
                flush()
                blocks.append(.item(String(trimmed[...dot]), String(trimmed[trimmed.index(dot, offsetBy: 2)...])))
            } else {
                paragraph.append(trimmed)
            }
        }
        // An unclosed fence still shows what was in it.
        if let code { blocks.append(.code(code.joined(separator: "\n"))) }
        flush()
        return blocks
    }
}
