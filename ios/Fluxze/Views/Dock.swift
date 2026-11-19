import SwiftUI

/// An area of the app: a tab in the dock, or a row in the ⋯ menu.
enum AppArea: String, CaseIterable, Identifiable {
    case inbox, chat, reviews, tasks, calendar, drive

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .chat: "Chat"
        case .reviews: "Reviews"
        case .tasks: "Tasks"
        case .calendar: "Calendar"
        case .drive: "Drive"
        }
    }

    var icon: Image {
        switch self {
        case .inbox: Image(systemName: "tray")
        case .chat: Image(systemName: "bubble.left.and.bubble.right")
        // GitHub's pull request icon; tab bars draw icons in one tint.
        case .reviews: Image("PullRequest")
        case .tasks: Image(systemName: "checklist")
        case .calendar: Image(systemName: "calendar")
        case .drive: Image(systemName: "folder")
        }
    }

    var label: some View {
        Label { Text(title) } icon: { icon }
    }
}

/// Which areas sit in the dock; the rest are reached from its ⋯ tab.
enum Dock {
    static let storageKey = "dockAreas"
    /// The tab bar holds five: four areas and ⋯.
    static let capacity = 4

    /// The dock for a saved choice ("inbox,chat,…"), limited to the areas this
    /// account has. Nothing saved (or nothing of it left) gives the first four.
    static func areas(stored: String, available: [AppArea]) -> [AppArea] {
        var seen = Set<AppArea>()
        let chosen = stored.split(separator: ",")
            .compactMap { AppArea(rawValue: String($0)) }
            .filter { available.contains($0) && seen.insert($0).inserted }
        return Array((chosen.isEmpty ? available : chosen).prefix(capacity))
    }

    static func store(_ areas: [AppArea]) -> String {
        areas.map(\.rawValue).joined(separator: ",")
    }
}

/// The sheet the ⋯ tab opens: Settings, Customize dock, then the areas that
/// aren't in the dock.
struct MoreMenu: View {
    let areas: [AppArea]
    let onPick: (AppArea) -> Void
    let onSettings: () -> Void
    let onCustomize: () -> Void

    static let rowHeight: CGFloat = 52

    /// Tall enough for its rows, so the sheet hugs them.
    static func height(areas: Int) -> CGFloat {
        CGFloat(areas + 2) * rowHeight + 56
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("Settings", icon: Image(systemName: "gearshape"), action: onSettings)
            row("Customize dock", icon: Image(systemName: "square.grid.2x2"), action: onCustomize)
            if !areas.isEmpty {
                Divider().padding(.horizontal, 20).padding(.vertical, 6)
            }
            ForEach(areas) { area in
                row(area.title, icon: area.icon) { onPick(area) }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 28)
        .presentationDetents([.height(Self.height(areas: areas.count))])
        .presentationDragIndicator(.visible)
    }

    private func row(_ title: String, icon: Image, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                icon.frame(width: 28)
                Text(title)
                Spacer()
            }
            .font(.body)
            .padding(.horizontal, 28)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Customize dock: pick up to four areas for the tab bar and put them in order.
struct CustomizeDockView: View {
    let available: [AppArea]
    @Binding var stored: String
    @Environment(\.dismiss) private var dismiss

    private var dock: [AppArea] { Dock.areas(stored: stored, available: available) }
    private var rest: [AppArea] { available.filter { !dock.contains($0) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(dock) { area in
                        HStack(spacing: 12) {
                            Button { save(dock.filter { $0 != area }) } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                            // The dock keeps at least one area.
                            .disabled(dock.count == 1)
                            .accessibilityLabel("Remove \(area.title) from the dock")
                            area.label
                            Spacer()
                            Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary)
                        }
                    }
                    .onMove { from, to in
                        var moved = dock
                        moved.move(fromOffsets: from, toOffset: to)
                        save(moved)
                    }
                } header: {
                    Text("In the dock")
                } footer: {
                    Text("Up to \(Dock.capacity). Touch and hold a row, then drag to reorder.")
                }

                if !rest.isEmpty {
                    Section {
                        ForEach(rest) { area in
                            HStack(spacing: 12) {
                                Button { save(dock + [area]) } label: {
                                    Image(systemName: "plus.circle.fill").foregroundStyle(.green)
                                }
                                .buttonStyle(.borderless)
                                .disabled(dock.count >= Dock.capacity)
                                .accessibilityLabel("Add \(area.title) to the dock")
                                area.label
                            }
                        }
                    } header: {
                        Text("Under ⋯")
                    } footer: {
                        if dock.count >= Dock.capacity {
                            Text("The dock is full. Remove an area to add another.")
                        }
                    }
                }
            }
            .navigationTitle("Customize dock")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { stored = "" }.disabled(stored.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func save(_ areas: [AppArea]) {
        withAnimation { stored = Dock.store(areas) }
    }
}
