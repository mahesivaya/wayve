import SwiftUI

/// The Home tab: one search across your mail, tasks and meetings. Mail uses the
/// server's search (all folders, as in the Email tab); tasks and meetings are
/// matched on the phone against what the other tabs load.
struct HomeView: View {
    @StateObject private var emails: EmailsStore
    @StateObject private var tasks: TasksStore
    @StateObject private var meetings: MeetingsStore

    @State private var text = ""
    @State private var searched = ""
    @State private var isSearching = false
    @State private var showingSettings = false
    @State private var editingTask: TaskItem?
    @State private var editingMeeting: Meeting?
    @FocusState private var fieldFocused: Bool

    init(api: APIClient, userID: Int?) {
        _emails = StateObject(wrappedValue: EmailsStore(api: api, userID: userID))
        _tasks = StateObject(wrappedValue: TasksStore(api: api))
        _meetings = StateObject(wrappedValue: MeetingsStore(api: api))
    }

    var body: some View {
        NavigationStack {
            content
                .safeAreaInset(edge: .top) { searchField }
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .navigationDestination(for: EmailSummary.self) { email in
                    EmailDetailView(store: emails, email: email)
                }
                .sheet(item: $editingTask) { TaskEditView(store: tasks, task: $0) }
                .sheet(item: $editingMeeting) { meeting in
                    MeetingEditView(store: meetings, meeting: meeting, day: meeting.day ?? .now)
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .onAppear { if searched.isEmpty { fieldFocused = true } }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search mail, tasks and meetings", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($fieldFocused)
                .onSubmit { Task { await search() } }
            if !text.isEmpty {
                Button {
                    text = ""
                    searched = ""
                    fieldFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(Color(.secondarySystemBackground), in: Capsule())
        .padding(.horizontal)
        .padding(.bottom, 8)
        .background(.bar)
    }

    @ViewBuilder
    private var content: some View {
        if searched.isEmpty {
            ContentUnavailableView(
                "Search Fluxze",
                systemImage: "magnifyingglass",
                description: Text("Find emails, tasks and meetings in one place.")
            )
        } else if isSearching {
            ProgressView()
        } else if mailHits.isEmpty, taskHits.isEmpty, meetingHits.isEmpty {
            ContentUnavailableView.search(text: searched)
        } else {
            List {
                if !mailHits.isEmpty {
                    Section("Email") {
                        ForEach(mailHits) { email in
                            NavigationLink(value: email) { EmailRow(email: email, mailbox: nil) }
                        }
                    }
                }
                if !taskHits.isEmpty {
                    Section("Tasks") {
                        ForEach(taskHits) { task in
                            Button { editingTask = task } label: {
                                TaskRow(task: task, status: tasks.status(for: task.status),
                                        project: tasks.project(for: task.projectId),
                                        finished: tasks.isFinished(task))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if !meetingHits.isEmpty {
                    Section("Meetings") {
                        ForEach(meetingHits) { meeting in
                            Button { editingMeeting = meeting } label: {
                                MeetingRow(meeting: meeting, showDate: true)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private var mailHits: [EmailSummary] { Array(emails.emails.prefix(10)) }

    private var taskHits: [TaskItem] {
        Array(tasks.tasks.filter { Self.matches(searched, [$0.name, $0.description, $0.assignee]) }.prefix(10))
    }

    private var meetingHits: [Meeting] {
        Array(meetings.meetings
            .filter { Self.matches(searched, [$0.title] + ($0.participants ?? [])) }
            .sorted { ($0.date, $0.startMinutes) > ($1.date, $1.startMinutes) }
            .prefix(10))
    }

    /// Every word of the query appears somewhere in the fields, ignoring case
    /// and accents ("acme review" finds "Review of ACME's plan").
    static func matches(_ query: String, _ fields: [String?]) -> Bool {
        let haystack = fields.compactMap { $0 }.joined(separator: " ")
        let words = query.split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { return false }
        return words.allSatisfy {
            haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    private func search() async {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        searched = query
        isSearching = true
        defer { isSearching = false }
        emails.query = query
        async let mail: Void = emails.load()
        async let taskList: Void = tasks.hasLoaded ? () : tasks.load()
        async let meetingList: Void = meetings.hasLoaded ? () : meetings.load()
        _ = await (mail, taskList, meetingList)
    }
}
