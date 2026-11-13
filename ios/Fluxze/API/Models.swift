import Foundation

/// A task as returned by `GET /api/tasks` (backend `models/task.rs`).
/// Named `TaskItem` so it doesn't shadow Swift Concurrency's `Task`.
struct TaskItem: Codable, Identifiable, Hashable {
    let id: Int
    let taskNumber: Int?
    var name: String
    var description: String
    /// 1 = Highest … 5 = Lowest.
    var priority: Int
    /// A task-status slug.
    var status: String
    var assignedBy: String
    var assignee: String
    var assigneeId: Int?
    var projectId: Int?
    let createdAt: Date?
    let updatedAt: Date?
}

/// Body of `POST /api/tasks` and `PUT /api/tasks/{id}`. PUT is a full replace,
/// so an edit always starts from the existing task (`init(from:)`) and carries
/// over the fields this app doesn't show, such as the assignee.
struct TaskInput: Encodable, Equatable {
    var name: String
    var description: String
    var priority: Int
    var status: String?
    var assignedBy: String
    var assignee: String
    var assigneeId: Int?
    var projectId: Int?

    init(
        name: String = "",
        description: String = "",
        priority: Int = 3,
        status: String? = nil,
        assignedBy: String = "",
        assignee: String = "",
        assigneeId: Int? = nil,
        projectId: Int? = nil
    ) {
        self.name = name
        self.description = description
        self.priority = priority
        self.status = status
        self.assignedBy = assignedBy
        self.assignee = assignee
        self.assigneeId = assigneeId
        self.projectId = projectId
    }

    init(from task: TaskItem) {
        self.init(
            name: task.name,
            description: task.description,
            priority: task.priority,
            status: task.status,
            assignedBy: task.assignedBy,
            assignee: task.assignee,
            assigneeId: task.assigneeId,
            projectId: task.projectId
        )
    }
}

/// `GET /api/task-statuses` (backend `tasks/statuses.rs`).
struct TaskStatus: Codable, Identifiable, Hashable {
    let id: Int
    let slug: String
    let name: String
    let description: String?
    let color: String?
    /// backlog | planned | in_progress | completed | canceled
    let category: String
    let position: Int?

    /// Completed and canceled statuses count as finished, as on the web.
    var isFinished: Bool { category == "completed" || category == "canceled" }
}

/// `GET /api/projects`.
struct Project: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
}

/// The parts of `GET /api/me` the app uses.
struct Me: Codable, Equatable {
    /// Picks this user's slot in multi-recipient envelopes.
    let id: Int?
    let email: String
    let username: String?
    let accountType: String?
}

enum Priority {
    static let all = [1, 2, 3, 4, 5]

    static func label(_ priority: Int) -> String {
        switch priority {
        case 1: return "Highest"
        case 2: return "High"
        case 3: return "Medium"
        case 4: return "Low"
        default: return "Lowest"
        }
    }
}
