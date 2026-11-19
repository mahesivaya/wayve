import SwiftUI
import UserNotifications

/// The app's notifications, all raised on the phone itself: a banner when a
/// chat message or new mail is seen while the app is running, a reminder
/// before each meeting, and the unread count on the app icon. There is no
/// server push, so chat and mail banners stop once iOS has suspended the app;
/// meeting reminders are handed to iOS ahead of time and arrive regardless.
enum Notifier {
    /// Settings → Notifications: one switch for everything, then one per
    /// kind. All are on until turned off; iOS's own permission still decides
    /// whether anything shows.
    static let enabledKey = "notifyEnabled"
    static let mailKey = "notifyNewMail"
    static let chatKey = "notifyChatMessages"
    static let reviewsKey = "notifyReviews"
    static let meetingsKey = "notifyMeetings"

    /// Whether a kind is wanted: its own switch, under the main one.
    static func isOn(_ key: String, defaults: UserDefaults = .standard) -> Bool {
        let on = { (key: String) in defaults.object(forKey: key) as? Bool ?? true }
        return on(enabledKey) && (key == enabledKey || on(key))
    }

    static func status() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Shows iOS's permission prompt (once; afterwards it only reports the answer).
    @discardableResult
    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Lets banners show while the app is open, where iOS hides them by default.
    static func start() {
        UNUserNotificationCenter.current().delegate = ForegroundBanners.shared
    }

    /// The banner's text. Only who it's from: chat is end-to-end encrypted, so
    /// what they wrote stays off the lock screen.
    static func chatContent(from sender: String?) -> (title: String, body: String) {
        let name = sender?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (name.isEmpty ? "Hadal" : name, "New message")
    }

    /// A message arrived in a conversation that isn't the one on screen.
    static func chatMessage(from sender: String?, senderID: Int) {
        guard isOn(chatKey) else { return }
        let text = chatContent(from: sender)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        content.sound = .default
        // One banner per person: a newer message replaces the older banner.
        let request = UNNotificationRequest(identifier: "chat-\(senderID)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: Mail

    /// "Ana Lopez" over the subject, as a mail app shows it.
    static func mailContent(_ email: EmailSummary) -> (title: String, body: String) {
        (EmailText.name(of: email.sender), email.displaySubject)
    }

    /// At most this many banners for one check, so a burst of mail isn't a burst of sound.
    static let mailBannersPerCheck = 3

    static func newMail(_ emails: [EmailSummary]) {
        guard isOn(mailKey) else { return }
        for email in emails.prefix(mailBannersPerCheck) {
            let text = mailContent(email)
            let content = UNMutableNotificationContent()
            content.title = text.title
            content.body = text.body
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "mail-\(email.id)", content: content, trigger: nil))
        }
    }

    // MARK: Reviews

    /// "ana opened a pull request" over its title.
    static func reviewContent(_ item: ReviewItem) -> (title: String, body: String) {
        ("\(item.pr.user?.login ?? "Someone") opened a pull request", item.pr.title)
    }

    static func newReviews(_ items: [ReviewItem]) {
        guard isOn(reviewsKey) else { return }
        for item in items.prefix(mailBannersPerCheck) {
            let text = reviewContent(item)
            let content = UNMutableNotificationContent()
            content.title = text.title
            content.body = text.body
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "review-\(item.id)", content: content, trigger: nil))
        }
    }

    // MARK: Meetings

    /// How long before a meeting its reminder shows.
    static let meetingLead: TimeInterval = 10 * 60
    /// iOS keeps at most 64 waiting notifications per app; the soonest meetings get them.
    static let meetingLimit = 30
    private static let meetingPrefix = "meeting-"

    struct Reminder: Equatable {
        let id: String
        let title: String
        let body: String
        let fireAt: Date
    }

    /// A reminder ten minutes before each meeting still far enough ahead, soonest first.
    static func reminders(for meetings: [Meeting], now: Date = .now) -> [Reminder] {
        meetings
            .compactMap { meeting -> Reminder? in
                guard let start = meeting.start else { return nil }
                let fireAt = start.addingTimeInterval(-meetingLead)
                guard fireAt > now else { return nil }
                let title = meeting.title.trimmingCharacters(in: .whitespacesAndNewlines)
                return Reminder(
                    id: "\(meetingPrefix)\(meeting.id)", title: title.isEmpty ? "Meeting" : title,
                    body: "Starts at \(start.formatted(date: .omitted, time: .shortened))", fireAt: fireAt)
            }
            .sorted { ($0.fireAt, $0.id) < ($1.fireAt, $1.id) }
            .prefix(meetingLimit)
            .map { $0 }
    }

    /// Replaces the waiting meeting reminders with ones for this list (none
    /// when reminders are turned off).
    static func scheduleMeetings(_ meetings: [Meeting]) {
        let center = UNUserNotificationCenter.current()
        let wanted = isOn(meetingsKey) ? reminders(for: meetings) : []
        center.getPendingNotificationRequests { pending in
            center.removePendingNotificationRequests(
                withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(meetingPrefix) })
            for reminder in wanted {
                let content = UNMutableNotificationContent()
                content.title = reminder.title
                content.body = reminder.body
                content.sound = .default
                let when = Calendar.current.dateComponents(
                    [.year, .month, .day, .hour, .minute, .second], from: reminder.fireAt)
                center.add(UNNotificationRequest(
                    identifier: reminder.id, content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
            }
        }
    }

    /// Reads the meetings and schedules their reminders, without the Calendar
    /// tab having been opened.
    static func refreshMeetings(api: APIClient) async {
        guard let meetings: [Meeting] = try? await api.get("/api/meetings") else { return }
        scheduleMeetings(meetings)
    }

    // MARK: App icon

    /// The number on the app icon: unread mail plus unread chat, or none when
    /// notifications are turned off.
    static func badgeCount(mail: Int, chat: Int, enabled: Bool) -> Int {
        enabled ? max(mail, 0) + max(chat, 0) : 0
    }

    static func setBadge(mail: Int, chat: Int) {
        UNUserNotificationCenter.current()
            .setBadgeCount(badgeCount(mail: mail, chat: chat, enabled: isOn(enabledKey))) { _ in }
    }

    /// Signing out clears what the last account left behind.
    static func clear() {
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }
}

private final class ForegroundBanners: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ForegroundBanners()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Settings → Notifications: one switch for all of them at the top, then
/// Email, Chat, Reviews and Meetings, each on until turned off.
struct NotificationSettingsView: View {
    @AppStorage(Notifier.enabledKey) private var enabled = true
    @AppStorage(Notifier.mailKey) private var mail = true
    @AppStorage(Notifier.chatKey) private var chat = true
    @AppStorage(Notifier.reviewsKey) private var reviews = true
    @AppStorage(Notifier.meetingsKey) private var meetings = true
    @EnvironmentObject private var appState: AppState
    @State private var status: UNAuthorizationStatus?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            Section {
                Toggle("Enable notifications", isOn: $enabled)
            } footer: {
                if status == .denied, enabled {
                    // iOS has the last word; say so and offer the way there.
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Notifications for Hadal are turned off in iOS Settings, so none will show.")
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            Link("Open iOS Settings", destination: url)
                        }
                    }
                }
            }

            Section {
                Toggle("Email", isOn: $mail)
                Toggle("Chat", isOn: $chat)
                Toggle("Reviews", isOn: $reviews)
                Toggle("Meetings", isOn: $meetings)
            } footer: {
                Text("Email, chat and review notifications arrive while Hadal is open or was just in use. Meeting reminders come 10 minutes before the start, even when Hadal is closed.")
            }
            .disabled(!enabled)
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await askIfNeeded() }
        .onChange(of: enabled) { _, _ in
            Task {
                await askIfNeeded()
                await Notifier.refreshMeetings(api: appState.api)
            }
        }
        // Turning reminders on or off schedules or withdraws them at once.
        .onChange(of: meetings) { _, _ in Task { await Notifier.refreshMeetings(api: appState.api) } }
        // Coming back from iOS Settings: show what was chosen there.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { status = await Notifier.status() } }
        }
    }

    /// iOS asks once; with notifications enabled here, this is when.
    private func askIfNeeded() async {
        status = await Notifier.status()
        if enabled, status == .notDetermined {
            await Notifier.requestPermission()
            status = await Notifier.status()
        }
    }
}
