import Foundation

@MainActor
final class TasksStore: ObservableObject {
    @Published private(set) var tasks: [TaskItem] = []
    @Published private(set) var statuses: [TaskStatus] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let statusList: [TaskStatus] = api.get("/api/task-statuses")
            async let taskList: [TaskItem] = api.get("/api/tasks")
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
        let created: TaskItem = try await api.post("/api/tasks", body: input)
        tasks.append(created)
    }

    func update(_ task: TaskItem, with input: TaskInput) async throws {
        let updated: TaskItem = try await api.put("/api/tasks/\(task.id)", body: input)
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
            let updated: TaskItem = try await api.put("/api/tasks/\(task.id)", body: input)
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
            try await api.delete("/api/tasks/\(task.id)")
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
