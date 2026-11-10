import XCTest
@testable import Fluxze

final class ServerDateTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_794_313_496) // 2026-11-10T12:24:56Z

    func testNaiveTimestampIsUTC() {
        XCTAssertEqual(ServerDate.parse("2026-11-10T12:24:56"), base)
    }

    func testFractionalDigits() throws {
        let micro = try XCTUnwrap(ServerDate.parse("2026-11-10T12:24:56.123456"))
        XCTAssertEqual(micro.timeIntervalSince(base), 0.123456, accuracy: 1e-6)
        let one = try XCTUnwrap(ServerDate.parse("2026-11-10T12:24:56.5"))
        XCTAssertEqual(one.timeIntervalSince(base), 0.5, accuracy: 1e-6)
    }

    func testOffsets() {
        XCTAssertEqual(ServerDate.parse("2026-11-10T12:24:56Z"), base)
        XCTAssertEqual(ServerDate.parse("2026-11-10T14:24:56+02:00"), base)
        XCTAssertEqual(ServerDate.parse("2026-11-10T07:24:56-0500"), base)
    }

    func testRejectsGarbage() {
        XCTAssertNil(ServerDate.parse("yesterday"))
        XCTAssertNil(ServerDate.parse("2026-11-10"))
    }
}

final class TaskModelTests: XCTestCase {
    private let json = """
    [{"id":7,"task_number":12,"name":"Ship app","description":"","priority":1,"status":"in_progress",
      "assigned_by":"lead","assignee":"Sam","assignee_id":42,"project_id":3,
      "created_at":"2026-11-10T12:24:56.123456","updated_at":null,
      "jira_issue_key":null,"jira_base":null,"gitlab_issue_iid":null,"gitlab_web_url":null},
     {"id":8,"task_number":null,"name":"Imported","description":"d","priority":5,"status":"to_do",
      "assigned_by":"","assignee":"","assignee_id":null,"project_id":null,
      "created_at":null,"updated_at":null}]
    """

    @MainActor
    func testDecodesServerTasks() throws {
        let tasks = try APIClient.decoder.decode([TaskItem].self, from: Data(json.utf8))
        XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(tasks[0].taskNumber, 12)
        XCTAssertEqual(tasks[0].assigneeId, 42)
        XCTAssertNotNil(tasks[0].createdAt)
        XCTAssertNil(tasks[0].updatedAt)
        XCTAssertNil(tasks[1].taskNumber)
    }

    /// PUT is a full replace: an edit must carry over fields the app doesn't show.
    @MainActor
    func testEditKeepsAssigneeAndProject() throws {
        let task = try APIClient.decoder.decode([TaskItem].self, from: Data(json.utf8))[0]
        var input = TaskInput(from: task)
        input.name = "Ship app v2"
        let body = try JSONSerialization.jsonObject(
            with: APIClient.encoder.encode(input)) as? [String: Any]
        XCTAssertEqual(body?["name"] as? String, "Ship app v2")
        XCTAssertEqual(body?["assignee"] as? String, "Sam")
        XCTAssertEqual(body?["assigned_by"] as? String, "lead")
        XCTAssertEqual(body?["assignee_id"] as? Int, 42)
        XCTAssertEqual(body?["project_id"] as? Int, 3)
        XCTAssertEqual(body?["status"] as? String, "in_progress")
        XCTAssertEqual(body?["priority"] as? Int, 1)
    }

    func testFinishedCategories() {
        func status(_ category: String) -> TaskStatus {
            TaskStatus(id: 1, slug: "s", name: "S", description: nil, color: "#00ff00",
                       category: category, position: 0)
        }
        XCTAssertTrue(status("completed").isFinished)
        XCTAssertTrue(status("canceled").isFinished)
        XCTAssertFalse(status("in_progress").isFinished)
        XCTAssertFalse(status("backlog").isFinished)
    }
}

final class APIErrorTests: XCTestCase {
    func testMessageBody() {
        XCTAssertEqual(APIError.from(status: 400, data: Data(#"{"message":"Task name is required"}"#.utf8)),
                       .server(status: 400, code: nil, message: "Task name is required"))
    }

    func testErrorAndMessageBody() {
        let error = APIError.from(status: 403, data: Data(#"{"error":"email_unverified","message":"Verify first"}"#.utf8))
        XCTAssertEqual(error.code, "email_unverified")
        XCTAssertEqual(error.errorDescription, "Verify first")
    }

    func testUnauthorized() {
        XCTAssertEqual(APIError.from(status: 401, data: Data(#"{"message":"Invalid credentials"}"#.utf8)),
                       .unauthorized("Invalid credentials"))
        XCTAssertEqual(APIError.from(status: 401, data: Data(#"{"message":"unauthorized"}"#.utf8)),
                       .unauthorized("Your session has expired. Please sign in again."))
    }

    func testPlainTextAndEmptyBodies() {
        XCTAssertEqual(APIError.from(status: 429, data: Data()).errorDescription,
                       "Too many attempts. Please wait a minute and try again.")
        XCTAssertEqual(APIError.from(status: 429, data: Data("Too many requests".utf8)).errorDescription,
                       "Too many requests")
        XCTAssertEqual(APIError.from(status: 500, data: Data("boom".utf8)).errorDescription,
                       "Something went wrong on the server. Please try again.")
    }
}
