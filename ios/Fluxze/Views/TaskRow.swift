import SwiftUI

struct TaskRow: View {
    let task: TaskItem
    let status: TaskStatus?
    let project: Project?
    let finished: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "flag.fill")
                .foregroundStyle(PriorityStyle.color(task.priority))
                .accessibilityLabel("Priority \(Priority.label(task.priority))")
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.name)
                    .strikethrough(finished)
                    .foregroundStyle(finished ? .secondary : .primary)
                    .lineLimit(2)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            Text(status?.name ?? task.status)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background((Color(hex: status?.color) ?? .gray).opacity(0.18), in: Capsule())
                .foregroundStyle(Color(hex: status?.color) ?? .secondary)
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String? {
        var parts: [String] = []
        if let number = task.taskNumber { parts.append("#\(number)") }
        if let project { parts.append(project.name) }
        if !task.assignee.isEmpty { parts.append(task.assignee) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
