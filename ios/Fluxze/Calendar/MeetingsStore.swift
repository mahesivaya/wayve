import Foundation

/// The reply to a create or update. `invitesSent` is false when the meeting has
/// participants but their invite emails failed.
struct MeetingSaveResponse: Decodable {
    let invitesSent: Bool?
}

@MainActor
final class MeetingsStore: ObservableObject {
    @Published private(set) var meetings: [Meeting] = []
    @Published private(set) var isLoading = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?

    let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let list: [Meeting] = try await api.get("/api/meetings")
            meetings = list
            errorMessage = nil
        } catch APIError.unauthorized {
            // AppState signs out.
        } catch {
            errorMessage = error.localizedDescription
        }
        hasLoaded = true
    }

    /// The meetings on `day`, earliest first.
    func meetings(on day: Date, timeZone: TimeZone = .current) -> [Meeting] {
        let key = WallClock.string(day: day, timeZone: timeZone)
        return meetings
            .filter { $0.date == key }
            .sorted { ($0.startMinutes, $0.id) < ($1.startMinutes, $1.id) }
    }

    #if DEBUG
    func replaceForTesting(_ list: [Meeting]) { meetings = list }
    #endif

    /// Returns whether invites went out (nil when nobody was invited).
    /// The list response carries no new row, so the list is reloaded.
    @discardableResult
    func create(_ input: MeetingInput) async throws -> Bool? {
        let reply: MeetingSaveResponse = try await api.post("/api/meetings", body: input)
        await load()
        return reply.invitesSent
    }

    @discardableResult
    func update(_ meeting: Meeting, with input: MeetingInput) async throws -> Bool? {
        let reply: MeetingSaveResponse = try await api.put("/api/meetings/\(meeting.id)", body: input)
        await load()
        return reply.invitesSent
    }

    func delete(_ meeting: Meeting) async {
        guard let index = meetings.firstIndex(where: { $0.id == meeting.id }) else { return }
        meetings.remove(at: index)
        do {
            try await api.delete("/api/meetings/\(meeting.id)")
        } catch {
            meetings.insert(meeting, at: min(index, meetings.count))
            errorMessage = error.localizedDescription
        }
    }
}
