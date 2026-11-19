import Foundation

/// The three boards that share the task shape and screens: your tasks, and
/// the workspace's user stories and tickets (organization and platform
/// accounts). Statuses and projects are the same for all three.
enum Board: String {
    case tasks, stories, tickets

    /// Where its items are listed, created, changed and deleted.
    var path: String {
        switch self {
        case .tasks: "/api/tasks"
        case .stories: "/api/user-stories"
        case .tickets: "/api/workspace-tickets"
        }
    }

    /// "task", for the middle of a sentence.
    var noun: String {
        switch self {
        case .tasks: "task"
        case .stories: "user story"
        case .tickets: "ticket"
        }
    }

    var plural: String {
        switch self {
        case .tasks: "tasks"
        case .stories: "user stories"
        case .tickets: "tickets"
        }
    }

    /// "Task", for the start of one: "Task #12", "Task name".
    var name: String { noun.prefix(1).uppercased() + noun.dropFirst() }

    var systemImage: String {
        switch self {
        case .tasks: "checklist"
        case .stories: "book"
        case .tickets: "ticket"
        }
    }
}

@MainActor
final class TasksStore: ObservableObject {
    @Published private(set) var tasks: [TaskItem] = []
    @Published private(set) var statuses: [TaskStatus] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    let api: APIClient
    let board: Board

    init(api: APIClient, board: Board = .tasks) {
        self.api = api
        self.board = board
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let statusList: [TaskStatus] = api.get("/api/task-statuses")
            async let taskList: [TaskItem] = api.get(board.path)
            async let projectList: [Project] = api.get("/api/projects")
            statuses = try await statusList.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
            tasks = try await taskList
            // Projects only label tasks; a failure there shouldn't hide them.
            projects = (try? await projectList) ?? projects
            errorMessage = nil
        } catch APIError.unauthorized {
            // AppState signs out.
        } catch {
            errorMessage = error.localizedDescription
        }
        hasLoaded = true
    }

    func status(for slug: String) -> TaskStatus? {
        statuses.first { $0.slug == slug }
    }

    func project(for id: Int?) -> Project? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    func isFinished(_ task: TaskItem) -> Bool {
        status(for: task.status)?.isFinished ?? false
    }

    func create(_ input: TaskInput) async throws {
        let created: TaskItem = try await api.post(board.path, body: input)
        tasks.append(created)
    }

    func update(_ task: TaskItem, with input: TaskInput) async throws {
        let updated: TaskItem = try await api.put("\(board.path)/\(task.id)", body: input)
        replace(updated)
    }

    /// Moves a task to another status straight away, and puts it back if the
    /// server refuses.
    func setStatus(_ task: TaskItem, to slug: String) async {
        guard task.status != slug else { return }
        var input = TaskInput(from: task)
        input.status = slug
        var optimistic = task
        optimistic.status = slug
        replace(optimistic)
        do {
            let updated: TaskItem = try await api.put("\(board.path)/\(task.id)", body: input)
            replace(updated)
        } catch {
            replace(task)
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ task: TaskItem) async {
        guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks.remove(at: index)
        do {
            try await api.delete("\(board.path)/\(task.id)")
        } catch {
            tasks.insert(task, at: min(index, tasks.count))
            errorMessage = error.localizedDescription
        }
    }

    private func replace(_ task: TaskItem) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        }
    }
}
