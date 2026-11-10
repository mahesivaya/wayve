import SwiftUI

struct TaskListView: View {
    @StateObject var store: TasksStore
    @State private var search = ""
    @State private var statusFilter: String?
    @State private var priorityFilter: Int?
    @State private var showCompleted = false
    @State private var editing: TaskItem?
    @State private var creating = false
    @State private var showingSettings = false
    @State private var pendingDelete: TaskItem?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Tasks")
                .searchable(text: $search, prompt: "Search tasks")
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        filterMenu
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New task")
                            .disabled(store.statuses.isEmpty)
                    }
                }
                .sheet(isPresented: $creating) {
                    TaskEditView(store: store, task: nil)
                }
                .sheet(item: $editing) { task in
                    TaskEditView(store: store, task: task)
                }
                .sheet(isPresented: $showingSettings) {
                    SettingsView()
                }
                .confirmationDialog(
                    "Delete this task?",
                    isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                    titleVisibility: .visible,
                    presenting: pendingDelete
                ) { task in
                    Button("Delete", role: .destructive) { Task { await store.delete(task) } }
                } message: { task in
                    Text(task.name)
                }
                .alert(
                    "Something went wrong",
                    isPresented: Binding(get: { store.errorMessage != nil && store.hasLoaded && !store.tasks.isEmpty },
                                         set: { if !$0 { store.errorMessage = nil } })
                ) {
                    Button("OK", role: .cancel) { store.errorMessage = nil }
                } message: {
                    Text(store.errorMessage ?? "")
                }
        }
        .task { if !store.hasLoaded { await store.load() } }
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasLoaded {
            ProgressView()
        } else if store.tasks.isEmpty, let message = store.errorMessage {
            ContentUnavailableView {
                Label("Couldn't load tasks", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
            }
        } else if store.tasks.isEmpty {
            ContentUnavailableView {
                Label("No tasks yet", systemImage: "checklist")
            } description: {
                Text("Tap + to add your first task.")
            }
        } else {
            List {
                let active = filtered.filter { !store.isFinished($0) }
                let done = filtered.filter { store.isFinished($0) }

                Section("Active (\(active.count))") {
                    if active.isEmpty {
                        Text(isFiltering ? "No matching tasks" : "Nothing left to do")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(active) { row($0) }
                }

                if !done.isEmpty {
                    Section {
                        DisclosureGroup("Completed (\(done.count))", isExpanded: $showCompleted) {
                            ForEach(done) { row($0) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private func row(_ task: TaskItem) -> some View {
        Button { editing = task } label: {
            TaskRow(task: task,
                    status: store.status(for: task.status),
                    project: store.project(for: task.projectId),
                    finished: store.isFinished(task))
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { pendingDelete = task } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            if let done = store.statuses.first(where: { $0.category == "completed" }),
               !store.isFinished(task) {
                Button { Task { await store.setStatus(task, to: done.slug) } } label: {
                    Label(done.name, systemImage: "checkmark")
                }
                .tint(.green)
            }
        }
        .contextMenu {
            Menu("Move to") {
                ForEach(store.statuses) { status in
                    Button(status.name) { Task { await store.setStatus(task, to: status.slug) } }
                        .disabled(status.slug == task.status)
                }
            }
            Button("Edit") { editing = task }
            Button("Delete", role: .destructive) { pendingDelete = task }
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Status", selection: $statusFilter) {
                Text("All statuses").tag(String?.none)
                ForEach(store.statuses) { Text($0.name).tag(String?.some($0.slug)) }
            }
            Picker("Priority", selection: $priorityFilter) {
                Text("All priorities").tag(Int?.none)
                ForEach(Priority.all, id: \.self) { Text(Priority.label($0)).tag(Int?.some($0)) }
            }
            if isFiltering {
                Button("Clear filters") {
                    statusFilter = nil
                    priorityFilter = nil
                }
            }
        } label: {
            Image(systemName: isFiltering
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter")
    }

    private var isFiltering: Bool {
        statusFilter != nil || priorityFilter != nil || !search.isEmpty
    }

    private var filtered: [TaskItem] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        return store.tasks.filter { task in
            if let statusFilter, task.status != statusFilter { return false }
            if let priorityFilter, task.priority != priorityFilter { return false }
            if !query.isEmpty,
               !task.name.lowercased().contains(query),
               !task.description.lowercased().contains(query) { return false }
            return true
        }
    }
}
