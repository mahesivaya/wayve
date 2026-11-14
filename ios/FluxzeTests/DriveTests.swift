import XCTest
@testable import Fluxze

@MainActor
final class DriveTests: XCTestCase {
    func testDecodesFilesAndFolders() throws {
        let files = try APIClient.decoder.decode([DriveFile].self, from: Data("""
        [{"id": 7, "name": "Q3 report.pdf", "file_type": "pdf", "size": 2048,
          "created_at": "2026-11-13T09:30:00", "shared": false, "permission": null}]
        """.utf8))
        XCTAssertEqual(files.first?.name, "Q3 report.pdf")
        XCTAssertEqual(files.first?.size, 2048)
        XCTAssertNotNil(files.first?.createdAt)

        let folders = try APIClient.decoder.decode([DriveFolder].self, from: Data("""
        [{"id": 3, "user_id": 1, "parent_folder_id": null, "name": "Invoices", "created_at": "2026-11-13T09:30:00"}]
        """.utf8))
        XCTAssertEqual(folders.first?.name, "Invoices")
        XCTAssertNil(folders.first?.parentFolderId)
    }

    func testSafeNameCannotEscapeTheTempFolder() {
        XCTAssertEqual(DriveService.safeName("../../etc/passwd"), ".._.._etc_passwd")
        XCTAssertEqual(DriveService.safeName("a:b.txt"), "a_b.txt")
        XCTAssertEqual(DriveService.safeName(".."), "file")
        XCTAssertEqual(DriveService.safeName("  "), "file")
    }

    func testIcons() {
        func file(_ name: String) -> DriveFile {
            DriveFile(id: 1, name: name, fileType: nil, size: nil, createdAt: nil)
        }
        XCTAssertEqual(DriveService.icon(for: file("a.PDF")), "doc.richtext")
        XCTAssertEqual(DriveService.icon(for: file("photo.heic")), "photo")
        XCTAssertEqual(DriveService.icon(for: file("noext")), "doc")
    }
}
