import SwiftUI

/// One day hour by hour, 00:00 to 24:00, with its meetings drawn at their times
/// (overlapping meetings side by side). Opened from "Day view" in Calendar.
struct DayTimelineView: View {
    @ObservedObject var store: MeetingsStore
    @State var day: Date

    @State private var editing: Meeting?
    @State private var creatingAt: Int?

    static let hourHeight: CGFloat = 60
    private let labelWidth: CGFloat = 52

    private var meetings: [Meeting] { store.meetings(on: day) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                ZStack(alignment: .topLeading) {
                    hourGrid
                    blocks
                        .padding(.leading, labelWidth + 6)
                        .padding(.trailing, 8)
                    if Calendar.current.isDateInToday(day) { nowLine }
                }
                .frame(height: Self.hourHeight * 24 + 12)
                .padding(.top, 8)
            }
            .onAppear { proxy.scrollTo(Self.firstHour(meetings: meetings, day: day), anchor: .top) }
            .onChange(of: day) { _, _ in
                withAnimation { proxy.scrollTo(Self.firstHour(meetings: meetings, day: day), anchor: .top) }
            }
        }
        .navigationTitle(day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { shift(-1) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Previous day")
                Button { shift(1) } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel("Next day")
            }
            if #available(iOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { creatingAt = Self.defaultStartHour(day: day) } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New meeting")
            }
        }
        .sheet(item: $editing) { meeting in
            MeetingEditView(store: store, meeting: meeting, day: day, onSaved: { _ in })
        }
        .sheet(isPresented: Binding(get: { creatingAt != nil }, set: { if !$0 { creatingAt = nil } })) {
            // Starts at the hour that was tapped.
            MeetingEditView(store: store, meeting: nil, day: day,
                            startMinutes: creatingAt.map { $0 * 60 }, onSaved: { _ in })
        }
    }

    // MARK: Pieces

    /// A row per hour: its label and a hairline. Tapping an empty hour starts a
    /// new meeting on this day.
    private var hourGrid: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 6) {
                    Text(Self.hourLabel(hour))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: labelWidth, alignment: .trailing)
                        .offset(y: -7)
                    VStack { Divider() }
                }
                .frame(height: Self.hourHeight, alignment: .top)
                .contentShape(Rectangle())
                .onTapGesture { creatingAt = hour }
                .id(hour)
            }
        }
    }

    private var blocks: some View {
        GeometryReader { geo in
            let laid = Self.layout(meetings)
            ForEach(laid, id: \.meeting.id) { item in
                let width = geo.size.width / CGFloat(item.columns)
                Button { editing = item.meeting } label: {
                    MeetingBlock(meeting: item.meeting)
                }
                .buttonStyle(.plain)
                .frame(width: max(width - 3, 20), height: Self.height(of: item.meeting))
                .offset(x: width * CGFloat(item.column), y: Self.y(minutes: item.meeting.startMinutes))
            }
        }
    }

    private var nowLine: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let comps = Calendar.current.dateComponents([.hour, .minute], from: context.date)
            let minutes = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
            HStack(spacing: 0) {
                Circle().fill(Color.red).frame(width: 8, height: 8)
                Rectangle().fill(Color.red).frame(height: 1.5)
            }
            .padding(.leading, labelWidth + 2)
            .offset(y: Self.y(minutes: minutes) - 4)
            .allowsHitTesting(false)
        }
    }

    private func shift(_ days: Int) {
        if let next = Calendar.current.date(byAdding: .day, value: days, to: day) {
            day = next
        }
    }

    // MARK: Geometry (static, so it's testable)

    static func y(minutes: Int) -> CGFloat {
        CGFloat(minutes) / 60 * hourHeight
    }

    /// At least 20 minutes tall, so a short meeting stays tappable.
    static func height(of meeting: Meeting) -> CGFloat {
        let minutes = max(meeting.endMinutes - meeting.startMinutes, 20)
        return CGFloat(minutes) / 60 * hourHeight - 2
    }

    static func hourLabel(_ hour: Int) -> String {
        var comps = DateComponents()
        comps.hour = hour
        let date = Calendar.current.date(from: comps) ?? .now
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// Where the day opens: an hour before the first meeting, else the current
    /// hour today, else 8 am.
    static func firstHour(meetings: [Meeting], day: Date) -> Int {
        if let first = meetings.map(\.startMinutes).min() {
            return max(first / 60 - 1, 0)
        }
        if Calendar.current.isDateInToday(day) {
            return max(Calendar.current.component(.hour, from: .now) - 1, 0)
        }
        return 8
    }

    static func defaultStartHour(day: Date) -> Int {
        // The next hour today (never past 11 pm), else 9 am.
        Calendar.current.isDateInToday(day) ? min(Calendar.current.component(.hour, from: .now) + 1, 23) : 9
    }

    struct Placed {
        let meeting: Meeting
        let column: Int
        let columns: Int
    }

    /// Side-by-side columns for meetings that overlap: each cluster of
    /// overlapping meetings shares its width evenly, like a calendar app.
    static func layout(_ meetings: [Meeting]) -> [Placed] {
        let sorted = meetings.sorted { ($0.startMinutes, $0.endMinutes) < ($1.startMinutes, $1.endMinutes) }
        var result: [Placed] = []
        var cluster: [(meeting: Meeting, column: Int)] = []
        var columnEnds: [Int] = []
        var clusterEnd = -1

        func flush() {
            let columns = max(columnEnds.count, 1)
            result += cluster.map { Placed(meeting: $0.meeting, column: $0.column, columns: columns) }
            cluster = []
            columnEnds = []
        }

        for meeting in sorted {
            let end = max(meeting.endMinutes, meeting.startMinutes + 20)
            if meeting.startMinutes >= clusterEnd { flush() }
            if let free = columnEnds.firstIndex(where: { $0 <= meeting.startMinutes }) {
                columnEnds[free] = end
                cluster.append((meeting, free))
            } else {
                columnEnds.append(end)
                cluster.append((meeting, columnEnds.count - 1))
            }
            clusterEnd = max(clusterEnd, end)
        }
        flush()
        return result
    }
}

private struct MeetingBlock: View {
    let meeting: Meeting

    var body: some View {
        let tint = meeting.isFromGoogle ? Color.green : Color.accentColor
        VStack(alignment: .leading, spacing: 1) {
            Text(meeting.title)
                .font(.caption.weight(.semibold))
                .lineLimit(2)
            Text("\(meeting.startTime) – \(meeting.endTime)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(tint.opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
    }
}
