import SwiftUI

/// Create (`task == nil`) or edit a task.
struct TaskEditView: View {
    @ObservedObject var store: TasksStore
    let task: TaskItem?

    @Environment(\.dismiss) private var dismiss
    @State private var input: TaskInput
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var confirmDelete = false

    init(store: TasksStore, task: TaskItem?) {
        self.store = store
        self.task = task
        var initial = task.map(TaskInput.init(from:)) ?? TaskInput()
        if task == nil {
            initial.status = store.statuses.first?.slug
        }
        _input = State(initialValue: initial)
    }

    private var canSave: Bool {
        !input.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Task name", text: $input.name)
                    TextField("Description", text: $input.description, axis: .vertical)
                        .lineLimit(3...10)
                }

                Section {
                    Picker("Status", selection: Binding(
                        get: { input.status ?? store.statuses.first?.slug ?? "" },
                        set: { input.status = $0 }
                    )) {
                        ForEach(store.statuses) { Text($0.name).tag($0.slug) }
                    }
                    Picker("Priority", selection: $input.priority) {
                        ForEach(Priority.all, id: \.self) { Text(Priority.label($0)).tag($0) }
                    }
                    if !store.projects.isEmpty {
                        Picker("Project", selection: $input.projectId) {
                            Text("None").tag(Int?.none)
                            ForEach(store.projects) { Text($0.name).tag(Int?.some($0.id)) }
                        }
                    }
                }

                if let task, !task.assignee.isEmpty || !task.assignedBy.isEmpty {
                    Section {
                        if !task.assignee.isEmpty { LabeledContent("Assignee", value: task.assignee) }
                        if !task.assignedBy.isEmpty { LabeledContent("Assigned by", value: task.assignedBy) }
                    }
                }

                if let task, let created = task.createdAt {
                    Section {
                        LabeledContent("Created", value: created.formatted(date: .abbreviated, time: .shortened))
                        if let updated = task.updatedAt {
                            LabeledContent("Updated", value: updated.formatted(date: .abbreviated, time: .shortened))
                        }
                    }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                if task != nil {
                    Section {
                        Button("Delete task", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(task == nil ? "New task" : (task?.taskNumber.map { "Task #\($0)" } ?? "Edit task"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }.disabled(!canSave)
                    }
                }
            }
            .confirmationDialog("Delete this task?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let task {
                        Task { await store.delete(task) }
                        dismiss()
                    }
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        var body = input
        body.name = body.name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let task {
                try await store.update(task, with: body)
            } else {
                try await store.create(body)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
