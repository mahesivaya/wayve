import SwiftUI

/// The inbox of every mailbox the user connected on the web, newest first.
struct EmailListView: View {
    @StateObject var store: EmailsStore
    @State private var showingSettings = false
    @State private var searchText = ""

    var body: some View {
        NavigationStack {
            content
                // The inbox has no title; other folders say where you are.
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $searchText, prompt: "Search mail")
                .onSubmit(of: .search) { applySearch(searchText) }
                .onChange(of: searchText) { _, new in
                    // Clearing the field goes back to the inbox.
                    if new.isEmpty, !store.query.isEmpty { applySearch("") }
                }
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { folderMenu }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .navigationDestination(for: EmailSummary.self) { email in
                    EmailDetailView(store: store, email: email)
                }
                .alert(
                    "Something went wrong",
                    isPresented: Binding(get: { store.errorMessage != nil && store.hasLoaded && !store.emails.isEmpty },
                                         set: { if !$0 { store.errorMessage = nil } })
                ) {
                    Button("OK", role: .cancel) { store.errorMessage = nil }
                } message: {
                    Text(store.errorMessage ?? "")
                }
        }
        .task { if !store.hasLoaded { await store.load() } }
    }

    private var title: String {
        if !store.query.isEmpty { return "Search" }
        return store.folder == .inbox ? "" : store.folder.title
    }

    /// ☰: switch folder, like the web inbox's sidebar.
    private var folderMenu: some View {
        Menu {
            Picker("Folder", selection: Binding(
                get: { store.folder },
                set: { folder in
                    store.folder = folder
                    Task { await store.load() }
                }
            )) {
                ForEach(MailFolder.allCases) { folder in
                    Label(folder.title, systemImage: folder.systemImage).tag(folder)
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal")
        }
        .accessibilityLabel("Folders")
    }

    private func applySearch(_ text: String) {
        store.query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { await store.load() }
    }

    @ViewBuilder
    private var content: some View {
        if !store.hasLoaded {
            ProgressView()
        } else if store.emails.isEmpty, let message = store.errorMessage {
            ContentUnavailableView {
                Label("Couldn't load mail", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
            }
        } else if store.emails.isEmpty, store.accounts.isEmpty, store.query.isEmpty, store.folder == .inbox {
            ContentUnavailableView {
                Label("No mailbox connected", systemImage: "envelope")
            } description: {
                Text("Connect Gmail, Outlook or another mailbox in Fluxze on the web, and its mail shows up here.")
            } actions: {
                Link("Open Fluxze", destination: Config.webURL("/emails"))
            }
        } else if store.emails.isEmpty {
            ContentUnavailableView(
                store.query.isEmpty ? "Nothing in \(store.folder.title)" : "No results",
                systemImage: store.query.isEmpty ? store.folder.systemImage : "magnifyingglass",
                description: store.query.isEmpty ? nil : Text("Nothing matches “\(store.query)”.")
            )
        } else {
            List {
                ForEach(store.emails) { email in
                    NavigationLink(value: email) {
                        EmailRow(email: email,
                                 mailbox: store.accountID == nil && store.accounts.count > 1
                                    ? store.account(for: email.accountId)?.label : nil,
                                 showRecipient: store.query.isEmpty && [.sent, .drafts].contains(store.folder))
                    }
                    .onAppear {
                        if email.id == store.emails.last?.id { Task { await store.loadMore() } }
                    }
                }
                if store.isLoadingMore {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
        }
    }
}

struct EmailRow: View {
    let email: EmailSummary
    /// Which mailbox it came to, shown when listing several.
    let mailbox: String?
    /// Sent and Drafts name who the mail is to, not the sender (you).
    var showRecipient = false

    private var who: String {
        showRecipient ? "To: \(EmailText.name(of: email.receiver))" : EmailText.name(of: email.sender)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(email.isRead ? Color.clear : Color.accentColor)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(who)
                        .font(.body.weight(email.isRead ? .regular : .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let date = email.listDate {
                        Text(Self.shortDate(date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 4) {
                    Text(email.displaySubject)
                        .font(.subheadline.weight(email.isRead ? .regular : .semibold))
                        .foregroundStyle(email.isRead ? .secondary : .primary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    if email.hasAttachments == true {
                        Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary)
                    }
                    if email.isStarred == true {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                    }
                }
                if let mailbox {
                    Text(mailbox).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint(email.isRead ? "" : "Unread")
    }

    /// Time today, weekday this week, otherwise the date.
    static func shortDate(_ date: Date, now: Date = .now) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month(.abbreviated).day())
        }
        return date.formatted(date: .numeric, time: .omitted)
    }
}
