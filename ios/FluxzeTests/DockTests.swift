import XCTest
@testable import Fluxze

final class DockTests: XCTestCase {
    private let everything = AppArea.allCases

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
