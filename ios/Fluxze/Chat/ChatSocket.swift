import Foundation

/// The live chat connection (`/ws/chat`), as the web's `useChatSocket`:
/// authenticated with `?token=` (the server derives the user from it), kept
/// alive by the server's ping every 25s (URLSession answers pings itself), and
/// reconnected after a drop with capped exponential backoff plus jitter.
@MainActor
final class ChatSocket {
    /// Each text frame, as received.
    var onFrame: ((Data) -> Void)?
    /// After every (re)connect, so the store can fetch what it missed.
    var onOpen: (() -> Void)?
    var onStateChange: ((Bool) -> Void)?

    private let baseURL: URL
    private let token: @MainActor () -> String?
    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .ephemeral)
    private var attempt = 0
    private var stopped = true
    private var generation = 0

    init(baseURL: URL, token: @escaping @MainActor () -> String?) {
        self.baseURL = baseURL
        self.token = token
    }

    static func url(base: URL, token: String) -> URL? {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/ws/chat"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    func start() {
        guard stopped else { return }
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onStateChange?(false)
    }

    /// Sends one JSON frame; false if the socket isn't open.
    @discardableResult
    func send(_ data: Data) -> Bool {
        guard let task, task.state == .running else { return false }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
        return true
    }

    private func connect() {
        guard !stopped, let token = token(), let url = Self.url(base: baseURL, token: token) else { return }
        generation += 1
        let mine = generation
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        // The first frame received (or a successful ping) proves it's open.
        task.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self, mine == self.generation else { return }
                if error == nil {
                    self.attempt = 0
                    self.onStateChange?(true)
                    self.onOpen?()
                }
            }
        }
        receive(on: task, generation: mine)
    }

    private func receive(on task: URLSessionWebSocketTask, generation mine: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, mine == self.generation else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text): self.onFrame?(Data(text.utf8))
                    case .data(let data): self.onFrame?(data)
                    @unknown default: break
                    }
                    self.receive(on: task, generation: mine)
                case .failure:
                    self.onStateChange?(false)
                    self.scheduleReconnect()
                }
            }
        }
    }

    /// ~1s, 2s, 4s … at most 15s, ±20%.
    static func backoff(attempt: Int) -> TimeInterval {
        let base = min(pow(2, Double(attempt)), 15)
        return base * Double.random(in: 0.8...1.2)
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        let delay = Self.backoff(attempt: attempt)
        attempt += 1
        let mine = generation
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, mine == self.generation, !self.stopped else { return }
            self.connect()
        }
    }
}
