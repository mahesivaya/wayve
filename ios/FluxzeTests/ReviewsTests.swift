import XCTest
@testable import Fluxze

@MainActor
final class ReviewsTests: XCTestCase {
    private let repo = GitRepo(fullName: "acme/web", name: "web", owner: .init(login: "acme"))

    func testDecodesGitHubPullRequests() throws {
        let pulls = try APIClient.decoder.decode([PullRequest].self, from: Data("""
        [{"id": 11, "number": 42, "title": "Add chat", "html_url": "https://github.com/acme/web/pull/42",
          "state": "open", "draft": false, "user": {"login": "ana", "id": 1}, "body": "**Why**: chat",
          "created_at": "2026-11-13T09:00:00Z", "updated_at": "2026-11-14T09:00:00Z", "merged_at": null,
          "head": {"ref": "feat/chat", "sha": "abc"}, "base": {"ref": "main", "sha": "def"}, "labels": []}]
        """.utf8))
        let pr = try XCTUnwrap(pulls.first)
        XCTAssertEqual(pr.number, 42)
        XCTAssertEqual(pr.user?.login, "ana")
        XCTAssertEqual(pr.head?.ref, "feat/chat")
        XCTAssertNotNil(pr.updatedAt)

        let visible = try APIClient.decoder.decode(VisibleProjects.self, from: Data("""
        {"unrestricted": true, "repos": [{"full_name": "acme/web", "name": "web", "owner": {"login": "acme"},
          "private": true, "default_branch": "main", "description": null, "language": "Rust",
          "updated_at": "2026-11-14T09:00:00Z"}]}
        """.utf8))
        XCTAssertEqual(visible.repos, [repo])
        XCTAssertNil(visible.connected)
    }

    func testStatusMatchesGitHub() {
        func item(state: String, draft: Bool?, merged: Bool) -> ReviewItem {
            ReviewItem(repo: repo, pr: PullRequest(
                id: 1, number: 1, title: "t", htmlUrl: URL(string: "https://github.com")!, state: state,
                draft: draft, user: nil, body: nil, createdAt: nil, updatedAt: nil,
                mergedAt: merged ? Date() : nil, head: nil, base: nil))
        }
        XCTAssertEqual(item(state: "open", draft: false, merged: false).status, .open)
        XCTAssertEqual(item(state: "open", draft: true, merged: false).status, .draft)
        XCTAssertEqual(item(state: "closed", draft: false, merged: true).status, .merged)
        XCTAssertEqual(item(state: "closed", draft: false, merged: false).status, .closed)
    }

    func testPathsAndNewestFirst() {
        XCTAssertEqual(ReviewsStore.pullsPath(repo, state: "open"),
                       "/api/github/repos/acme/web/pulls?state=open&per_page=50&sort=updated&direction=desc")
        func item(_ n: Int, updated: TimeInterval) -> ReviewItem {
            ReviewItem(repo: repo, pr: PullRequest(
                id: n, number: n, title: "t", htmlUrl: URL(string: "https://github.com")!, state: "open",
                draft: nil, user: nil, body: nil, createdAt: nil,
                updatedAt: Date(timeIntervalSince1970: updated), mergedAt: nil, head: nil, base: nil))
        }
        XCTAssertEqual(ReviewsStore.sorted([item(1, updated: 10), item(2, updated: 30), item(3, updated: 20)])
            .map(\.pr.number), [2, 3, 1])
    }

    func testGuestsDontSeeCode() {
        XCTAssertFalse(Me(id: 1, email: "g@x.com", username: nil, accountType: "organization",
                          effectiveRole: "guest").canSeeCode)
        XCTAssertTrue(Me(id: 1, email: "o@x.com", username: nil, accountType: "organization",
                         effectiveRole: "owner").canSeeCode)
        // An older server without the field: show it, the server still decides.
        XCTAssertTrue(Me(id: 1, email: "p@x.com", username: nil, accountType: "personal").canSeeCode)
    }

    func testChangedFilesDecodeAndPage() throws {
        let files = try APIClient.decoder.decode([PullFile].self, from: Data("""
        [{"sha": "a", "filename": "ios/Fluxze/Chat/ChatStore.swift", "status": "added", "additions": 352,
          "deletions": 0, "changes": 352, "patch": "@@ -0,0 +1,2 @@\\n+import Foundation\\n+"},
         {"sha": "b", "filename": "docs/new.md", "previous_filename": "docs/old.md", "status": "renamed",
          "additions": 0, "deletions": 0, "changes": 0}]
        """.utf8))
        XCTAssertEqual(files.map(\.status), ["added", "renamed"])
        XCTAssertEqual(files[1].previousFilename, "docs/old.md")
        XCTAssertNil(files[1].patch)

        let item = ReviewItem(repo: repo, pr: PullRequest(
            id: 1, number: 232, title: "t", htmlUrl: URL(string: "https://github.com")!, state: "open",
            draft: nil, user: nil, body: nil, createdAt: nil, updatedAt: nil, mergedAt: nil, head: nil, base: nil))
        XCTAssertEqual(ReviewsStore.filesPath(item, page: 2),
                       "/api/github/repos/acme/web/pulls/232/files?per_page=100&page=2")
    }

    func testFileIconsByName() {
        XCTAssertEqual(FileTypeIcon.kind(for: "backend/src/email/drafts.rs").icon, .logo("rust"))
        XCTAssertEqual(FileTypeIcon.kind(for: "frontend/src/api/emailDrafts.ts").icon, .logo("typescript"))
        XCTAssertEqual(FileTypeIcon.kind(for: "frontend/src/emails/DraftsList.tsx").icon, .logo("react"))
        XCTAssertEqual(FileTypeIcon.kind(for: "frontend/src/emails/emails.css").icon, .logo("css"))
        XCTAssertEqual(FileTypeIcon.kind(for: "infra/Dockerfile").icon, .logo("docker"))
        XCTAssertEqual(FileTypeIcon.kind(for: "README.MD").icon, .logo("markdown"))
        XCTAssertEqual(FileTypeIcon.kind(for: "LICENSE").icon, .symbol("doc"))
        XCTAssertEqual(FileTypeIcon.kind(for: ".gitignore").icon, .symbol("doc"))
        // Every logo the table names is in the app.
        let logos = Set(FileTypeIcon.byExtension.values.compactMap { kind -> String? in
            if case .logo(let name) = kind.icon { return name } else { return nil }
        }).union(["docker", "gnubash"])
        for name in logos {
            XCTAssertNotNil(UIImage(named: "FileTypes/\(name)", in: Bundle(for: AppState.self), compatibleWith: nil), name)
        }
    }

    func testFileRowShowsTheFolder() {
        XCTAssertEqual(PullFileRow.folder(of: "backend/crates/wayve-server/src/email/drafts.rs"),
                       "backend/crates/wayve-server/src/email/")
        XCTAssertNil(PullFileRow.folder(of: "README.md"))
    }

    func testDiffLineKinds() {
        XCTAssertEqual(PullFileDiffView.kind(of: "@@ -1,3 +1,4 @@"), .hunk)
        XCTAssertEqual(PullFileDiffView.kind(of: "+let x = 1"), .added)
        XCTAssertEqual(PullFileDiffView.kind(of: "-let x = 0"), .removed)
        XCTAssertEqual(PullFileDiffView.kind(of: " unchanged"), .context)
    }

    func testRefusedReposAreNotFailures() {
        // 403: on GitHub but not linked to a Fluxze project (or not granted).
        guard case .refused = ReviewsStore.result(of: .failure(
            APIError.server(status: 403, code: nil, message: "You don't have access to this repository")))
        else { return XCTFail("403 should be refused") }
        guard case .failed = ReviewsStore.result(of: .failure(
            APIError.server(status: 502, code: nil, message: "Bad gateway")))
        else { return XCTFail("502 should be a failure") }
        guard case .pulls(let pulls) = ReviewsStore.result(of: .success([])), pulls.isEmpty
        else { return XCTFail("success should carry the pulls") }
    }

    func testIconsAndColoursLikeGitHub() {
        XCTAssertEqual(StatusIcon.asset(for: .open), "PullRequest")
        XCTAssertEqual(StatusIcon.asset(for: .merged), "PullRequestMerged")
        XCTAssertEqual(StatusIcon.asset(for: .closed), "PullRequestClosed")
        XCTAssertEqual(StatusIcon.color(for: .open), StatusIcon.green)
        XCTAssertEqual(StatusIcon.color(for: .draft), StatusIcon.green)
        XCTAssertEqual(StatusIcon.color(for: .merged), StatusIcon.purple)
        XCTAssertEqual(StatusIcon.color(for: .closed), StatusIcon.purple)
        // Every icon is in the app's assets.
        for name in ["PullRequest", "PullRequestMerged", "PullRequestClosed"] {
            XCTAssertNotNil(UIImage(named: name, in: Bundle(for: AppState.self), compatibleWith: nil), name)
        }
    }

    func testMarkdownFallsBackToText() {
        XCTAssertEqual(String(PullRequestDetailView.markdown("**Bold** and `code`").characters), "Bold and code")
        XCTAssertFalse(String(PullRequestDetailView.markdown("line one\nline two").characters).isEmpty)
    }
}

@MainActor
final class ReviewsPageTests: XCTestCase {
    private let repo = GitRepo(fullName: "acme/web", name: "web", owner: .init(login: "acme"))

    private func item(_ number: Int, by author: String, state: String = "open", reviewers: [String] = []) -> ReviewItem {
        ReviewItem(repo: repo, pr: PullRequest(
            id: number, number: number, title: "PR \(number)",
            htmlUrl: URL(string: "https://github.com/acme/web/pull/\(number)") ?? URL(fileURLWithPath: "/"),
            state: state, draft: false, user: .init(login: author), body: nil,
            createdAt: nil, updatedAt: nil, mergedAt: nil, head: nil, base: nil,
            requestedReviewers: reviewers.map { .init(login: $0) }))
    }

    func testCreatedAndToReviewFollowYourLogin() {
        let items = [
            item(1, by: "Ana"), item(2, by: "bo", reviewers: ["ana"]),
            item(3, by: "bo", state: "closed", reviewers: ["ana"]), item(4, by: "cy"),
        ]
        func ids(_ scope: ReviewsStore.Scope, login: String?) -> [Int] {
            ReviewsStore.filter(items, repo: nil, scope: scope, login: login).map(\.pr.number)
        }
        XCTAssertEqual(ids(.created, login: "ana"), [1])
        // Only open ones still wait for a review.
        XCTAssertEqual(ids(.toReview, login: "ana"), [2])
        XCTAssertEqual(ids(.all, login: "ana"), [1, 2, 3, 4])
        // Without a login nothing can be called yours.
        XCTAssertEqual(ids(.created, login: nil), [])
        XCTAssertEqual(ids(.all, login: nil), [1, 2, 3, 4])
    }

    func testDecodesAPullRequestPage() throws {
        let pr = try APIClient.decoder.decode(PullRequest.self, from: Data("""
        {"id": 11, "number": 42, "title": "Add chat", "html_url": "https://github.com/acme/web/pull/42",
         "state": "open", "user": {"login": "ana"}, "body": null, "created_at": "2026-11-13T09:00:00Z",
         "head": {"ref": "feat/chat", "sha": "abc"}, "base": {"ref": "main", "sha": "def"},
         "requested_reviewers": [{"login": "bo"}], "additions": 12, "deletions": 3, "changed_files": 2}
        """.utf8))
        XCTAssertEqual(pr.head?.sha, "abc")
        XCTAssertEqual(pr.requestedReviewers?.map(\.login), ["bo"])
        XCTAssertEqual([pr.additions, pr.deletions, pr.changedFiles], [12, 3, 2])

        let runs = try APIClient.decoder.decode(CheckRuns.self, from: Data("""
        {"total_count": 2, "check_runs": [
          {"id": 1, "name": "test", "status": "completed", "conclusion": "success", "html_url": "https://github.com/x"},
          {"id": 2, "name": "lint", "status": "in_progress", "conclusion": null}]}
        """.utf8))
        XCTAssertEqual(runs.checkRuns.map(\.outcome), [.pass, .pending])
        XCTAssertEqual(ReviewsStore.checksPath(repo, sha: "abc"),
                       "/api/github/repos/acme/web/commits/abc/check-runs?per_page=100")
    }

    func testChecksAreTalliedLikeTheWeb() {
        func run(_ id: Int, _ status: String, _ conclusion: String?) -> CheckRun {
            CheckRun(id: id, name: "c\(id)", status: status, conclusion: conclusion)
        }
        XCTAssertEqual(CheckSummary([]).label, "No checks")
        XCTAssertNil(CheckSummary([]).outcome)
        let passed = CheckSummary([run(1, "completed", "success"), run(2, "completed", "neutral")])
        XCTAssertEqual(passed.label, "All passed")
        XCTAssertEqual(passed.outcome, .pass)
        XCTAssertEqual(CheckSummary([run(1, "completed", "success"), run(2, "completed", "skipped")]).label,
                       "1 passed, 1 skipped")
        // A failure outranks a check still running.
        let mixed = CheckSummary([run(1, "completed", "timed_out"), run(2, "queued", nil), run(3, "completed", "success")])
        XCTAssertEqual(mixed.label, "1 failing")
        XCTAssertEqual(mixed.outcome, .fail)
        XCTAssertEqual(CheckSummary([run(1, "queued", nil)]).label, "1 pending")
    }

    func testConversationAndVerdicts() {
        let t0 = Date(timeIntervalSince1970: 1_000), t1 = t0.addingTimeInterval(60), t2 = t0.addingTimeInterval(120)
        func review(_ id: Int, _ who: String, _ state: String, _ at: Date, body: String? = nil) -> PullReview {
            PullReview(id: id, user: .init(login: who), body: body, state: state, submittedAt: at)
        }
        let reviews = [
            review(1, "bo", "CHANGES_REQUESTED", t0, body: "Fix the test"),
            review(2, "bo", "APPROVED", t2),
            review(3, "cy", "COMMENTED", t1),              // wrapper around line comments
            review(4, "cy", "COMMENTED", t1, body: "Nice"),
            review(5, "di", "APPROVED", t0), review(6, "di", "DISMISSED", t1),
        ]
        let comments = [IssueComment(id: 9, user: .init(login: "ana"), body: "Ready", createdAt: t1)]
        let timeline = ReviewsStore.timeline(comments: comments, reviews: reviews)
        XCTAssertFalse(timeline.contains { $0.id == "r3" })
        XCTAssertEqual(timeline.first?.id, "r1")
        XCTAssertEqual(timeline.last?.id, "r2")
        XCTAssertEqual(timeline.first { $0.id == "c9" }?.reviewState, nil)

        // bo's later approval replaces the change request; di's was dismissed.
        XCTAssertEqual(ReviewsStore.verdicts(reviews), [Verdict(login: "bo", approved: true)])
        XCTAssertEqual(PullRequestDetailView.approvalsLabel(ReviewsStore.verdicts(reviews)), "Approved by bo")
        XCTAssertEqual(PullRequestDetailView.approvalsLabel([]), "No approvals yet")
        XCTAssertEqual(PullRequestDetailView.approvalsLabel([Verdict(login: "bo", approved: false), Verdict(login: "cy", approved: true)]),
                       "Changes requested by bo")
    }

    func testAvatarInitialsAndColour() {
        XCTAssertEqual(AuthorAvatar.initials("mahesivaya"), "MA")
        XCTAssertEqual(AuthorAvatar.initials("dependabot[bot]"), "DE")
        XCTAssertEqual(AuthorAvatar.initials("-"), "?")
        XCTAssertEqual(AuthorAvatar.color("Ana"), AuthorAvatar.color("ana"))
    }
}

@MainActor
final class PullRequestPageTests: XCTestCase {
    private let repo = GitRepo(fullName: "acme/web", name: "web", owner: .init(login: "acme"))

    private func item(state: String, merged: Bool = false, mergeable: Bool?) -> ReviewItem {
        ReviewItem(repo: repo, pr: PullRequest(
            id: 1, number: 7, title: "PR",
            htmlUrl: URL(string: "https://github.com/acme/web/pull/7") ?? URL(fileURLWithPath: "/"),
            state: state, draft: false, user: nil, body: nil, createdAt: nil, updatedAt: nil,
            mergedAt: merged ? Date() : nil, head: nil, base: nil, mergeable: mergeable))
    }

    func testBranchState() {
        XCTAssertEqual(ReviewsStore.branchState(item(state: "open", mergeable: false)), "Conflicts")
        XCTAssertEqual(ReviewsStore.branchState(item(state: "open", mergeable: true)), "No conflicts")
        XCTAssertEqual(ReviewsStore.branchState(item(state: "open", mergeable: nil)), "Checking…")
        XCTAssertEqual(ReviewsStore.branchState(item(state: "closed", merged: true, mergeable: nil)), "Merged")
        XCTAssertEqual(ReviewsStore.branchState(item(state: "closed", mergeable: false)), "Closed")
    }

    func testPagePaths() {
        let pr = item(state: "open", mergeable: nil)
        XCTAssertEqual(ReviewsStore.pullPath(pr), "/api/github/repos/acme/web/pulls/7")
        XCTAssertEqual(ReviewsStore.pullPath(pr, "/comments"), "/api/github/repos/acme/web/pulls/7/comments")
        XCTAssertEqual(ReviewsStore.commentsPath(pr), "/api/github/repos/acme/web/issues/7/comments?per_page=100")
    }
}

final class MarkdownTextTests: XCTestCase {
    func testBlocks() {
        let text = "User story #9: UI failing\n\n## Local checks passed\n- npx tsc\n* npm test\n1. first\n\nTwo\nlines\n```sh\n# not a heading\n- not a bullet\n```\n#hashtag"
        XCTAssertEqual(MarkdownText.blocks(text), [
            .paragraph("User story #9: UI failing"),
            .heading("Local checks passed"),
            .item("•", "npx tsc"), .item("•", "npm test"), .item("1.", "first"),
            .paragraph("Two\nlines"),
            .code("# not a heading\n- not a bullet"),
            .paragraph("#hashtag"),
        ])
        XCTAssertEqual(MarkdownText.blocks("```\nopen"), [.code("open")])
        XCTAssertEqual(MarkdownText.blocks("  \n"), [])
    }
}
