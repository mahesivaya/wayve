import SwiftUI

/// The inbox of every mailbox the user connected on the web, newest first.
struct EmailListView: View {
    /// Owned by MainTabView, which badges the Inbox tab from it.
    @ObservedObject var store: EmailsStore
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var composing = false
    @State private var creatingLabel = false
    /// The screen's width, so the search bar can fill the top bar.
    @State private var barWidth: CGFloat = 0

    var body: some View {
        NavigationStack {
            content
                // The inbox has no title; other folders say where you are.
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .onChange(of: searchText) { _, new in
                    // Clearing the field goes back to the folder.
                    if new.isEmpty, !store.query.isEmpty { applySearch("") }
                }
                .refreshable { await store.load() }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { folderMenu }
                    // Search sits in the top bar itself, between ☰ and the
                    // account button, rather than in a row of its own below.
                    ToolbarItem(placement: .principal) { searchField }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .sheet(isPresented: $showingSettings) { SettingsView() }
                .overlay(alignment: .bottomTrailing) { composeButton }
                .sheet(isPresented: $creatingLabel) { NewLabelView(store: store) }
                .sheet(isPresented: $composing) {
                    ComposeView(store: store, original: nil, mode: .new, originalText: nil)
                }
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
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { barWidth = proxy.size.width }
                    .onChange(of: proxy.size.width) { _, width in barWidth = width }
            }
        }
        .task { if !store.hasLoaded { await store.load() } }
    }

    /// The round ✎ button floating over the list, for a new email.
    private var composeButton: some View {
        Button { composing = true } label: {
            Image(systemName: "square.and.pencil")
                .font(.title2.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: 58, height: 58)
                .background(Color(.secondarySystemBackground), in: Circle())
                .shadow(color: .black.opacity(0.2), radius: 8, y: 3)
        }
        .accessibilityLabel("New email")
        .padding(.trailing, 20)
        .padding(.bottom, 16)
        .disabled(store.accounts.isEmpty)
        .opacity(store.accounts.isEmpty ? 0 : 1)
    }

    private var searchPrompt: String {
        let scope = EmailsStore.searchScope(folder: store.folder, label: store.label)
        return scope == .all ? "Search mail" : "Search in \(scope.title)"
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            // Says where the search really looks: all mail, unless this is
            // Spam, Drafts or Trash (EmailsStore.searchScope).
            TextField(searchPrompt, text: $searchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { applySearch(searchText) }
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12)
        .frame(height: 36)
        // Everything between ☰ and the account button (two 44pt buttons plus
        // the bar's margins); the toolbar would otherwise keep it narrow.
        .frame(width: max(200, barWidth - 128))
        .background(Color(.secondarySystemBackground), in: Capsule())
    }

    private var title: String {
        if !store.query.isEmpty { return "Search" }
        return store.isInbox ? "" : store.viewTitle
    }

    /// ☰: switch folder, like the web inbox's sidebar.
    private var folderMenu: some View {
        Menu {
            Section {
                ForEach(MailFolder.allCases) { folder in
                    Button { store.show(folder) } label: {
                        let current = store.label == nil && store.folder == folder
                        Label(folder.title, systemImage: current ? "checkmark" : folder.systemImage)
                    }
                }
            }
            // A line, then the mailboxes' own labels, as in Gmail's sidebar.
            Section("Labels") {
                Button { creatingLabel = true } label: {
                    Label("New label", systemImage: "plus")
                }
                .disabled(store.accounts.isEmpty)
                ForEach(store.labels) { label in
                    Button { store.show(label) } label: {
                        Label(labelTitle(label), systemImage: store.label == label ? "checkmark" : "tag")
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal")
        }
        .accessibilityLabel("Folders")
    }

    /// A label's name, with its mailbox when several are connected.
    private func labelTitle(_ label: MailLabel) -> String {
        store.accounts.count > 1 ? "\(label.name) · \(label.accountEmail)" : label.name
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
        } else if store.emails.isEmpty, store.accounts.isEmpty, store.query.isEmpty, store.isInbox {
            ContentUnavailableView {
                Label("No mailbox connected", systemImage: "envelope")
            } description: {
                Text("Connect Gmail, Outlook or another mailbox in Fluxze on the web, and its mail shows up here.")
            } actions: {
                Link("Open Fluxze", destination: Config.webURL("/emails"))
            }
        } else if store.emails.isEmpty {
            ContentUnavailableView(
                store.query.isEmpty ? "Nothing in \(store.viewTitle)" : "No results",
                systemImage: store.query.isEmpty ? (store.label == nil ? store.folder.systemImage : "tag") : "magnifyingglass",
                description: store.query.isEmpty ? nil : Text("Nothing matches “\(store.query)”.")
            )
        } else {
            List {
                ForEach(store.emails) { email in
                    NavigationLink(value: email) {
                        EmailRow(email: email,
                                 mailbox: store.accountID == nil && store.accounts.count > 1
                                    ? store.account(for: email.accountId)?.label : nil,
                                 showRecipient: store.query.isEmpty && store.label == nil && [.sent, .drafts].contains(store.folder))
                    }
                    .onAppear {
                        if email.id == store.emails.last?.id { Task { await store.loadMore() } }
                    }
                    // Tighter left margin than the list's default.
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 12))
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
        HStack(alignment: .top, spacing: 6) {
            Circle()
                .fill(email.isRead ? Color.clear : Color.accentColor)
                .frame(width: 7, height: 7)
                .padding(.top, 7)
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
