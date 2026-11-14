import SwiftUI

/// Create (`meeting == nil`) or edit a meeting.
struct MeetingEditView: View {
    @ObservedObject var store: MeetingsStore
    let meeting: Meeting?
    /// Called after a successful save with whether invites went out.
    var onSaved: (Bool?) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var day: Date
    @State private var start: Date
    @State private var end: Date
    @State private var participants: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var confirmDelete = false

    /// `startMinutes` sets a new meeting's start (minutes after midnight), as
    /// when an hour is tapped in the day timeline.
    init(store: MeetingsStore, meeting: Meeting?, day: Date, startMinutes requestedStart: Int? = nil,
         onSaved: @escaping (Bool?) -> Void = { _ in }) {
        self.store = store
        self.meeting = meeting
        self.onSaved = onSaved

        let startMinutes: Int
        let endMinutes: Int
        let initialDay = meeting?.day ?? day
        if let meeting {
            startMinutes = meeting.startMinutes
            endMinutes = meeting.endMinutes
        } else if let requestedStart {
            startMinutes = min(max(requestedStart, 0), 23 * 60)
            endMinutes = min(startMinutes + 30, 23 * 60 + 59)
        } else {
            // The next half hour (today) or 9:00 (another day), for 30 minutes.
            if Calendar.current.isDateInToday(day) {
                let now = WallClock.minutes(of: Date())
                startMinutes = min((now / 30 + 1) * 30, 23 * 60)
            } else {
                startMinutes = 9 * 60
            }
            endMinutes = min(startMinutes + 30, 23 * 60 + 59)
        }
        _title = State(initialValue: meeting?.title ?? "")
        _day = State(initialValue: initialDay)
        _start = State(initialValue: WallClock.date(initialDay, minutes: startMinutes))
        _end = State(initialValue: WallClock.date(initialDay, minutes: endMinutes))
        _participants = State(initialValue: (meeting?.participants ?? []).joined(separator: ", "))
    }

    private var startMinutes: Int { WallClock.minutes(of: start) }
    private var endMinutes: Int { WallClock.minutes(of: end) }

    private var validationMessage: String? {
        if endMinutes <= startMinutes { return "The meeting must end after it starts." }
        return nil
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && validationMessage == nil && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                }

                Section {
                    DatePicker("Date", selection: $day, displayedComponents: .date)
                    DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
                        .onChange(of: start) { old, new in
                            // Keep the length when the start moves, within the day.
                            let length = max(endMinutes - WallClock.minutes(of: old), 15)
                            let newEnd = min(WallClock.minutes(of: new) + length, 23 * 60 + 59)
                            end = WallClock.date(day, minutes: newEnd)
                        }
                    DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute)
                } footer: {
                    if let validationMessage {
                        Text(validationMessage).foregroundStyle(.red)
                    }
                }

                Section {
                    TextField("name@example.com, …", text: $participants, axis: .vertical)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(1...4)
                } header: {
                    Text("Invite")
                } footer: {
                    Text("Separate email addresses with commas. Each person gets an email invite.")
                }

                if let meeting, let url = meeting.joinURL {
                    Section {
                        Link(destination: url) { Label("Join meeting", systemImage: "video") }
                    }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                if meeting != nil {
                    Section {
                        Button("Delete meeting", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(meeting == nil ? "New meeting" : "Edit meeting")
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
            .confirmationDialog("Delete this meeting?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let meeting {
                        Task { await store.delete(meeting) }
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
        let input = MeetingInput(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            day: day,
            start: startMinutes,
            end: endMinutes,
            participants: MeetingInput.parseParticipants(participants)
        )
        do {
            let invitesSent: Bool?
            if let meeting {
                invitesSent = try await store.update(meeting, with: input)
            } else {
                invitesSent = try await store.create(input)
            }
            dismiss()
            onSaved(invitesSent)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
