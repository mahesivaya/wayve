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

    struct Author: Decodable, Hashable { let login: String }
    struct Ref: Decodable, Hashable { let ref: String }
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

    let api: APIClient
    private var generation = 0

    /// Repositories read at once, to stay polite to GitHub's rate limit.
    static let parallel = 6
    static let perPage = 50

    init(api: APIClient) {
        self.api = api
    }

    var shown: [ReviewItem] {
        guard let repoFilter else { return items }
        return items.filter { $0.repo == repoFilter }
    }

    /// Open (and draft) pull requests, then merged and closed ones, on one page.
    var open: [ReviewItem] { shown.filter { $0.status == .open || $0.status == .draft } }
    var closed: [ReviewItem] { shown.filter { $0.status == .merged || $0.status == .closed } }

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
            let visible: VisibleProjects = try await api.getKeepingSession("/api/projects/visible")
            guard mine == generation else { return }
            repos = visible.repos.sorted { $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending }
            notConnected = visible.connected == false
            if let repoFilter, !repos.contains(repoFilter) { self.repoFilter = nil }

            let (found, refused, failed) = await fetchPulls(repos)
            guard mine == generation else { return }
            items = Self.sorted(found)
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
