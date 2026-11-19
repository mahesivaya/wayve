import XCTest
@testable import Fluxze

final class DockTests: XCTestCase {
    private let everything = AppArea.allCases

    func testAreasByAccount() {
        // A personal account: no workspace boards.
        XCTAssertEqual(AppArea.available(canSeeCode: true, hasWorkspace: false),
                       [.inbox, .chat, .reviews, .tasks, .calendar, .drive])
        // An organization guest: the boards, but no Reviews.
        XCTAssertEqual(AppArea.available(canSeeCode: false, hasWorkspace: true),
                       [.inbox, .chat, .tasks, .calendar, .drive, .stories, .tickets])
        // They don't change the default dock.
        XCTAssertEqual(Dock.areas(stored: "", available: AppArea.available(canSeeCode: true, hasWorkspace: true)),
                       [.inbox, .chat, .reviews, .tasks])
    }

    func testBoardsUseTheirOwnEndpoints() {
        XCTAssertEqual(Board.tasks.path, "/api/tasks")
        XCTAssertEqual(Board.stories.path, "/api/user-stories")
        XCTAssertEqual(Board.tickets.path, "/api/workspace-tickets")
        XCTAssertEqual(Board.stories.name, "User story")
        XCTAssertEqual(Board.tickets.plural, "tickets")
    }

    func testNothingSavedGivesTheFirstFour() {
        XCTAssertEqual(Dock.areas(stored: "", available: everything), [.inbox, .chat, .reviews, .tasks])
        // A guest has no Reviews, so Calendar moves up.
        let guest = everything.filter { $0 != .reviews }
        XCTAssertEqual(Dock.areas(stored: "", available: guest), [.inbox, .chat, .tasks, .calendar])
    }

    func testASavedChoiceKeepsItsOrder() {
        let saved = Dock.store([.drive, .inbox])
        XCTAssertEqual(saved, "drive,inbox")
        XCTAssertEqual(Dock.areas(stored: saved, available: everything), [.drive, .inbox])
    }

    func testASavedChoiceIsCleanedUp() {
        // Unknown names, repeats, areas this account lacks, and a fifth are dropped.
        let guest = everything.filter { $0 != .reviews }
        XCTAssertEqual(
            Dock.areas(stored: "reviews,chat,chat,nope,inbox,tasks,drive,calendar", available: guest),
            [.chat, .inbox, .tasks, .drive])
        // Nothing usable left: back to the default.
        XCTAssertEqual(Dock.areas(stored: "reviews", available: guest), [.inbox, .chat, .tasks, .calendar])
    }
}
