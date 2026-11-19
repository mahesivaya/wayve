import Foundation

/// A repository you can see (`GET /api/projects/visible`, already filtered to
/// your grants on the server).
struct GitRepo: Decodable, Hashable, Identifiable {
    let fullName: String
    let name: String
    let owner: Owner

    struct Owner: Decodable, Hashable { let login: String }

    var id: String { fullName }
}

struct VisibleProjects: Decodable {
    let repos: [GitRepo]
    /// false: a personal account that hasn't connected GitHub yet.
    let connected: Bool?
}

/// One pull request, as GitHub returns it through `/api/github/repos/…/pulls`.
struct PullRequest: Decodable, Hashable {
    let id: Int
    let number: Int
    let title: String
    let htmlUrl: URL
    let state: String
    let draft: Bool?
    let user: Author?
    let body: String?
    let createdAt: Date?
    let updatedAt: Date?
    let mergedAt: Date?
    let head: Ref?
    let base: Ref?
    var requestedReviewers: [Author]? = nil
    /// Only on one pull request's own page (`GET …/pulls/{number}`), not in lists.
    var additions: Int? = nil
    var deletions: Int? = nil
    var changedFiles: Int? = nil
    /// Whether it merges cleanly; nil while GitHub is still working it out.
    var mergeable: Bool? = nil

    struct Author: Decodable, Hashable { let login: String }
    struct Ref: Decodable, Hashable {
        let ref: String
        /// The commit the branch points at; the head's carries the checks.
        var sha: String? = nil
    }
}

/// A comment in a pull request's conversation (`GET …/issues/{number}/comments`).
struct IssueComment: Decodable, Hashable, Identifiable {
    let id: Int
    let user: PullRequest.Author?
    let body: String?
    let createdAt: Date?
}

/// A submitted review (`GET …/pulls/{number}/reviews`).
struct PullReview: Decodable, Hashable, Identifiable {
    let id: Int
    let user: PullRequest.Author?
    let body: String?
    /// APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING.
    let state: String
    let submittedAt: Date?
}

/// One check on the head commit (`GET …/commits/{sha}/check-runs`).
struct CheckRun: Decodable, Hashable, Identifiable {
    let id: Int
    let name: String
    /// queued, in_progress, completed, …
    let status: String
    /// Set once completed: success, failure, neutral, cancelled, skipped, …
    let conclusion: String?
    var htmlUrl: URL? = nil

    enum Outcome: Int { case fail, pending, pass, skip }

    /// As the web counts it (`frontend/src/github/prMergeSummary.ts`).
    var outcome: Outcome {
        guard status == "completed", let conclusion else { return .pending }
        switch conclusion {
        case "success", "neutral": return .pass
        case "skipped", "stale": return .skip
        default: return .fail
        }
    }
}

struct CheckRuns: Decodable { let checkRuns: [CheckRun] }

/// A pull request's checks, tallied.
struct CheckSummary: Equatable {
    var total = 0, passed = 0, failing = 0, pending = 0, skipped = 0

    init(_ runs: [CheckRun]) {
        total = runs.count
        for run in runs {
            switch run.outcome {
            case .pass: passed += 1
            case .fail: failing += 1
            case .pending: pending += 1
            case .skip: skipped += 1
            }
        }
    }

    /// "6 failing", "2 pending", "All passed", "No checks".
    var label: String {
        if total == 0 { return "No checks" }
        if failing > 0 { return "\(failing) failing" }
        if pending > 0 { return "\(pending) pending" }
        return skipped > 0 ? "\(passed) passed, \(skipped) skipped" : "All passed"
    }

    /// The one that decides the colour: a failure beats a pending check.
    var outcome: CheckRun.Outcome? {
        if total == 0 { return nil }
        if failing > 0 { return .fail }
        return pending > 0 ? .pending : .pass
    }
}

/// `GET /api/github-oauth/connection`: your own GitHub account, if connected.
struct GitHubConnection: Decodable {
    let connected: Bool
    let login: String?
}

/// Everything one pull request's page shows, read together.
struct PullBundle {
    let detail: PullRequest
    let files: [PullFile]
    let comments: [IssueComment]
    let reviews: [PullReview]
    /// nil when the head commit's checks couldn't be read.
    let checkRuns: [CheckRun]?

    func adding(_ comment: IssueComment) -> PullBundle {
        PullBundle(detail: detail, files: files, comments: comments + [comment], reviews: reviews, checkRuns: checkRuns)
    }
}

/// One entry of a pull request's conversation: a comment or a review.
struct TimelineEntry: Identifiable, Equatable {
    let id: String
    let author: String
    let body: String
    let date: Date?
    /// A review's state; nil for a plain comment.
    let reviewState: String?
}

/// A reviewer's standing verdict.
struct Verdict: Equatable {
    let login: String
    let approved: Bool
}

/// One changed file in a pull request (`GET …/pulls/{number}/files`).
struct PullFile: Decodable, Hashable, Identifiable {
    let filename: String
    /// added, removed, modified, renamed, copied, changed or unchanged.
    let status: String
    let additions: Int
    let deletions: Int
    /// The unified diff; GitHub leaves it out for binary and very large files.
    let patch: String?
    let previousFilename: String?

    var id: String { filename }
}

/// A pull request with the repository it belongs to.
struct ReviewItem: Hashable, Identifiable {
    let repo: GitRepo
    let pr: PullRequest

    var id: String { "\(repo.fullName)#\(pr.number)" }

    /// Open, Draft, Merged or Closed, as on GitHub.
    var status: Status {
        if pr.mergedAt != nil { return .merged }
        if pr.state == "closed" { return .closed }
        return pr.draft == true ? .draft : .open
    }

    enum Status: String { case open = "Open", draft = "Draft", merged = "Merged", closed = "Closed" }
}

/// The Reviews tab: the pull requests of every repository you can see, newest
/// activity first. Read through the same GitHub proxy as the web's Code &
/// reviews, which checks each repository against your access.
@MainActor
final class ReviewsStore: ObservableObject {
    @Published private(set) var repos: [GitRepo] = []
    @Published private(set) var items: [ReviewItem] = []
    @Published private(set) var hasLoaded = false
    @Published private(set) var isLoading = false
    @Published private(set) var notConnected = false
    @Published var errorMessage: String?
    /// Repositories whose pull requests couldn't be read (no access, or GitHub refused).
    @Published private(set) var skipped: [String] = []
    /// nil = every repository.
    @Published var repoFilter: GitRepo?
    /// Your GitHub login, when you connected your own account; nil otherwise,
    /// and then the list can't tell which pull requests are yours.
    @Published private(set) var login: String?
    @Published var scope: Scope = .all
    /// Check tallies of open pull requests, by `ReviewItem.id`, read as rows appear.
    @Published private(set) var checks: [String: CheckSummary] = [:]

    /// Whose pull requests the list shows.
    enum Scope: String, CaseIterable, Identifiable {
        case created = "Created", toReview = "To review", all = "All"
        var id: String { rawValue }
    }

    let api: APIClient
    private var generation = 0
    /// The open pull requests at the last read; nil before the first one.
    private var knownOpen: Set<String>?

    /// Open pull requests that weren't there at the last read, leaving out
    /// your own (you know you opened them).
    static func arrived(in items: [ReviewItem], since known: Set<String>, login: String?) -> [ReviewItem] {
        items.filter { item in
            guard item.status == .open || item.status == .draft, !known.contains(item.id) else { return false }
            guard let login, let author = item.pr.user?.login else { return true }
            return author.caseInsensitiveCompare(login) != .orderedSame
        }
    }

    /// Repositories read at once, to stay polite to GitHub's rate limit.
    static let parallel = 6
    static let perPage = 50

    init(api: APIClient) {
        self.api = api
    }

    var shown: [ReviewItem] {
        Self.filter(items, repo: repoFilter, scope: scope, login: login)
    }

    /// Created: the ones you opened. To review: open ones asking for your
    /// review. Without a login only All can be told.
    static func filter(_ items: [ReviewItem], repo: GitRepo?, scope: Scope, login: String?) -> [ReviewItem] {
        let mine = { (author: PullRequest.Author?) in
            guard let login, let author else { return false }
            return author.login.caseInsensitiveCompare(login) == .orderedSame
        }
        return items.filter { item in
            if let repo, item.repo != repo { return false }
            switch scope {
            case .all: return true
            case .created: return mine(item.pr.user)
            case .toReview:
                return (item.status == .open || item.status == .draft)
                    && (item.pr.requestedReviewers ?? []).contains { mine($0) }
            }
        }
    }

    /// Open (and draft) pull requests, then merged ones, then those closed unmerged.
    var open: [ReviewItem] { shown.filter { $0.status == .open || $0.status == .draft } }
    var merged: [ReviewItem] { shown.filter { $0.status == .merged } }
    var closed: [ReviewItem] { shown.filter { $0.status == .closed } }

    /// Open and closed are asked for apart (two requests per repository):
    /// one `state=all` page is the 50 most recently updated, and a busy
    /// repository's recent merges would push its older open ones off it.
    static func pullsPath(_ repo: GitRepo, state: String) -> String {
        "/api/github/repos/\(repo.owner.login)/\(repo.name)/pulls?state=\(state)&per_page=\(perPage)&sort=updated&direction=desc"
    }

    static func sorted(_ items: [ReviewItem]) -> [ReviewItem] {
        items.sorted {
            let a = $0.pr.updatedAt ?? $0.pr.createdAt ?? .distantPast
            let b = $1.pr.updatedAt ?? $1.pr.createdAt ?? .distantPast
            return a == b ? $0.id < $1.id : a > b
        }
    }

    func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false; hasLoaded = true } }
        do {
            async let connection: GitHubConnection = api.getKeepingSession("/api/github-oauth/connection")
            let visible: VisibleProjects = try await api.getKeepingSession("/api/projects/visible")
            let me = (try? await connection)?.login
            guard mine == generation else { return }
            // The first time your login is known, start on your own pull requests.
            if login == nil, me != nil, scope == .all { scope = .created }
            if me == nil { scope = .all }
            login = me
            repos = visible.repos.sorted { $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending }
            notConnected = visible.connected == false
            if let repoFilter, !repos.contains(repoFilter) { self.repoFilter = nil }

            let (found, refused, failed) = await fetchPulls(repos)
            guard mine == generation else { return }
            items = Self.sorted(found)
            let open = items.filter { $0.status == .open || $0.status == .draft }
            // A repository that failed this time would look all-new next time.
            if failed.isEmpty {
                if let knownOpen { Notifier.newReviews(Self.arrived(in: open, since: knownOpen, login: login)) }
                knownOpen = Set(open.map(\.id))
            }
            // GitHub lists every repo on the account, but only those linked to
            // a Fluxze project (or granted to you) can be read; the rest are
            // refused with 403 by design, so they leave the list quietly.
            repos.removeAll { refused.contains($0.fullName) }
            if let repoFilter, !repos.contains(repoFilter) { self.repoFilter = nil }
            skipped = failed
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            errorMessage = Self.describe(error)
        }
    }

    /// What reading one repository's pull requests came to.
    enum RepoResult {
        case pulls([PullRequest])
        /// 403: not linked to a project, or not granted to you.
        case refused
        case failed
    }

    static func result(of outcome: Result<[PullRequest], Error>) -> RepoResult {
        switch outcome {
        case .success(let pulls): .pulls(pulls)
        case .failure(APIError.server(status: 403, _, _)): .refused
        case .failure: .failed
        }
    }

    /// Every repo's pull requests, a few repos at a time. Refused repos are
    /// returned apart from real failures, which are reported, not fatal.
    private func fetchPulls(_ repos: [GitRepo]) async -> ([ReviewItem], Set<String>, [String]) {
        var found: [ReviewItem] = []
        var refused: Set<String> = []
        var failed: [String] = []
        var index = 0
        while index < repos.count {
            let batch = repos[index..<min(index + Self.parallel, repos.count)]
            index += Self.parallel
            await withTaskGroup(of: (GitRepo, RepoResult).self) { group in
                for repo in batch {
                    group.addTask { @MainActor in
                        do {
                            async let open: [PullRequest] = self.api.getKeepingSession(Self.pullsPath(repo, state: "open"))
                            async let closed: [PullRequest] = self.api.getKeepingSession(Self.pullsPath(repo, state: "closed"))
                            let pulls = try await open + closed
                            return (repo, Self.result(of: .success(pulls)))
                        } catch {
                            return (repo, Self.result(of: .failure(error)))
                        }
                    }
                }
                for await (repo, result) in group {
                    switch result {
                    case .pulls(let pulls): found += pulls.map { ReviewItem(repo: repo, pr: $0) }
                    case .refused: refused.insert(repo.fullName)
                    case .failed: failed.append(repo.fullName)
                    }
                }
            }
        }
        return (found, refused, failed.sorted())
    }

    // MARK: Checks, for the list

    static func checksPath(_ repo: GitRepo, sha: String) -> String {
        "/api/github/repos/\(repo.owner.login)/\(repo.name)/commits/\(sha)/check-runs?per_page=100"
    }

    /// Reads an open pull request's checks once, for the icon on its row.
    func loadChecks(for item: ReviewItem) async {
        guard checks[item.id] == nil, let sha = item.pr.head?.sha else { return }
        guard let runs: CheckRuns = try? await api.getKeepingSession(Self.checksPath(item.repo, sha: sha)) else { return }
        checks[item.id] = CheckSummary(runs.checkRuns)
    }

    // MARK: One pull request's page

    static func pullPath(_ item: ReviewItem, _ tail: String = "") -> String {
        "/api/github/repos/\(item.repo.owner.login)/\(item.repo.name)/pulls/\(item.pr.number)\(tail)"
    }

    static func commentsPath(_ item: ReviewItem) -> String {
        "/api/github/repos/\(item.repo.owner.login)/\(item.repo.name)/issues/\(item.pr.number)/comments?per_page=100"
    }

    /// The pull request first; its files, conversation, reviews and checks
    /// together, each coming back empty on its own failure (as on the web).
    static func bundle(of item: ReviewItem, api: APIClient) async throws -> PullBundle {
        let detail: PullRequest = try await api.getKeepingSession(pullPath(item))
        async let files = try? Self.files(of: item, api: api)
        async let comments: [IssueComment]? = try? api.getKeepingSession(commentsPath(item))
        async let reviews: [PullReview]? = try? api.getKeepingSession(pullPath(item, "/reviews?per_page=100"))
        var runs: [CheckRun]?
        if let sha = detail.head?.sha {
            let found: CheckRuns? = try? await api.getKeepingSession(checksPath(item.repo, sha: sha))
            runs = found?.checkRuns
        }
        return PullBundle(
            detail: detail, files: await files ?? [], comments: await comments ?? [],
            reviews: await reviews ?? [], checkRuns: runs)
    }

    /// Adds a comment to the conversation (`POST …/pulls/{number}/comments`).
    /// It's posted as your connected GitHub account, else the server's.
    static func comment(on item: ReviewItem, body: String, api: APIClient) async throws -> IssueComment {
        struct Body: Encodable { let body: String }
        return try await api.postKeepingSession(pullPath(item, "/comments"), body: Body(body: body))
    }

    /// "Conflicts", "No conflicts", or where it ended up.
    static func branchState(_ item: ReviewItem) -> String {
        switch item.status {
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .open, .draft:
            guard let mergeable = item.pr.mergeable else { return "Checking…" }
            return mergeable ? "No conflicts" : "Conflicts"
        }
    }

    /// The conversation, oldest first. A bare COMMENTED review with no body is
    /// GitHub's wrapper around comments on lines of the diff, so it's left out.
    static func timeline(comments: [IssueComment], reviews: [PullReview]) -> [TimelineEntry] {
        let said = comments.map {
            TimelineEntry(id: "c\($0.id)", author: $0.user?.login ?? "unknown", body: $0.body ?? "",
                          date: $0.createdAt, reviewState: nil)
        }
        let reviewed = reviews
            .filter {
                !($0.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].contains($0.state)
            }
            .map {
                TimelineEntry(id: "r\($0.id)", author: $0.user?.login ?? "unknown", body: $0.body ?? "",
                              date: $0.submittedAt, reviewState: $0.state)
            }
        return (said + reviewed).sorted { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }
    }

    /// Each reviewer's standing verdict, as GitHub counts it: a later approval
    /// or change request replaces an earlier one, a dismissal clears it, and a
    /// plain comment changes nothing.
    static func verdicts(_ reviews: [PullReview]) -> [Verdict] {
        var latest: [String: Bool] = [:]
        var order: [String] = []
        for review in reviews.sorted(by: { ($0.submittedAt ?? .distantPast) < ($1.submittedAt ?? .distantPast) }) {
            guard let login = review.user?.login else { continue }
            switch review.state {
            case "APPROVED", "CHANGES_REQUESTED":
                if latest[login] == nil { order.append(login) }
                latest[login] = review.state == "APPROVED"
            case "DISMISSED":
                latest[login] = nil
                order.removeAll { $0 == login }
            default:
                break
            }
        }
        return order.compactMap { login in latest[login].map { Verdict(login: login, approved: $0) } }
    }

    // MARK: A pull request's changed files

    static let filesPerPage = 100
    /// GitHub lists at most 3,000 files; 10 pages of 100 covers most of that.
    static let maxFilePages = 10

    static func filesPath(_ item: ReviewItem, page: Int) -> String {
        "/api/github/repos/\(item.repo.owner.login)/\(item.repo.name)/pulls/\(item.pr.number)/files?per_page=\(filesPerPage)&page=\(page)"
    }

    /// Every changed file, a page at a time until a short page.
    static func files(of item: ReviewItem, api: APIClient) async throws -> [PullFile] {
        var all: [PullFile] = []
        for page in 1...maxFilePages {
            let batch: [PullFile] = try await api.getKeepingSession(filesPath(item, page: page))
            all += batch
            if batch.count < filesPerPage { break }
        }
        return all
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case APIError.unauthorized:
            return "GitHub isn't connected on the server, so pull requests can't be read."
        case APIError.server(status: 403, _, _):
            return "Your role doesn't have access to code."
        default:
            return error.localizedDescription
        }
    }
}
