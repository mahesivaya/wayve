import SwiftUI

/// A month calendar with the selected day's meetings underneath.
struct CalendarView: View {
    @StateObject var store: MeetingsStore
    @State private var selectedDay = Calendar.current.startOfDay(for: Date())
    @State private var editing: Meeting?
    @State private var creating = false
    @State private var showingSettings = false
    @State private var pendingDelete: Meeting?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Calendar")
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button("Today") {
                            withAnimation { selectedDay = Calendar.current.startOfDay(for: Date()) }
                        }
                        .disabled(Calendar.current.isDateInToday(selectedDay))
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New meeting")
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $creating) {
                    MeetingEditView(store: store, meeting: nil, day: selectedDay, onSaved: showSaved)
                }
                .sheet(item: $editing) { meeting in
                    MeetingEditView(store: store, meeting: meeting, day: selectedDay, onSaved: showSaved)
                }
                .sheet(isPresented: $showingSettings) {
                    SettingsView()
                }
                .confirmationDialog(
                    "Delete this meeting?",
                    isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                    titleVisibility: .visible,
                    presenting: pendingDelete
                ) { meeting in
                    Button("Delete", role: .destructive) { Task { await store.delete(meeting) } }
                } message: { meeting in
                    Text(meeting.title)
                }
                .alert(
                    "Something went wrong",
                    isPresented: Binding(get: { store.errorMessage != nil && store.hasLoaded && !store.meetings.isEmpty },
                                         set: { if !$0 { store.errorMessage = nil } })
                ) {
                    Button("OK", role: .cancel) { store.errorMessage = nil }
                } message: {
                    Text(store.errorMessage ?? "")
                }
                .alert(
                    "Meeting saved",
                    isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
                ) {
                    Button("OK", role: .cancel) { notice = nil }
                } message: {
                    Text(notice ?? "")
                }
        }
        .task { if !store.hasLoaded { await store.load() } }
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasLoaded {
            ProgressView()
        } else if store.meetings.isEmpty, let message = store.errorMessage {
            ContentUnavailableView {
                Label("Couldn't load your calendar", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
            }
        } else {
            List {
                Section {
                    DatePicker("Day", selection: $selectedDay, displayedComponents: .date)
                        .datePickerStyle(.graphical)
                }

                let dayMeetings = store.meetings(on: selectedDay)
                Section(selectedDay.formatted(.dateTime.weekday(.wide).month(.wide).day())) {
                    if dayMeetings.isEmpty {
                        Text("No meetings")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(dayMeetings) { row($0) }
                }

                let upcoming = upcomingMeetings
                if !upcoming.isEmpty {
                    Section("Upcoming") {
                        ForEach(upcoming) { meeting in
                            Button {
                                if let day = meeting.day { withAnimation { selectedDay = day } }
                            } label: {
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

    /// The next few meetings after the selected day, so a quiet day still
    /// shows what's coming.
    private var upcomingMeetings: [Meeting] {
        let after = WallClock.string(day: selectedDay)
        return store.meetings
            .filter { $0.date > after }
            .sorted { ($0.date, $0.startMinutes) < ($1.date, $1.startMinutes) }
            .prefix(5)
            .map { $0 }
    }

    private func row(_ meeting: Meeting) -> some View {
        Button { editing = meeting } label: {
            MeetingRow(meeting: meeting, showDate: false)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { pendingDelete = meeting } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .contextMenu {
            if let url = meeting.joinURL {
                Link(destination: url) { Label("Join meeting", systemImage: "video") }
            }
            Button("Edit") { editing = meeting }
            Button("Delete", role: .destructive) { pendingDelete = meeting }
        }
    }

    private func showSaved(invitesSent: Bool?) {
        if invitesSent == false {
            notice = "The meeting was saved, but the invite emails couldn't be sent."
        }
    }
}

struct MeetingRow: View {
    let meeting: Meeting
    let showDate: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 2)
                .fill(meeting.isFromGoogle ? Color.green : Color.accentColor)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 3) {
                Text(meeting.title)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                Text(timeText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let people = meeting.participants, !people.isEmpty {
                    Label(people.count == 1 ? people[0] : "\(people.count) people", systemImage: "person.2")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if meeting.joinURL != nil {
                Image(systemName: "video.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Has a video link")
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var timeText: String {
        guard let start = meeting.start, let end = meeting.end else {
            return "\(meeting.startTime) – \(meeting.endTime)"
        }
        let times = "\(start.formatted(date: .omitted, time: .shortened)) – \(end.formatted(date: .omitted, time: .shortened))"
        guard showDate else { return times }
        return "\(start.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())), \(times)"
    }
}
