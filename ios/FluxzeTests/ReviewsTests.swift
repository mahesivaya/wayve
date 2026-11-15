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
