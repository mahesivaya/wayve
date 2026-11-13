import SwiftUI
import WebKit

/// One email: its headers and body. Opening it marks it read.
struct EmailDetailView: View {
    @ObservedObject var store: EmailsStore
    let email: EmailSummary

    private enum BodyState {
        case loading
        case loaded(String)
        /// Sealed to the browser's key and the provider refetch failed (or a
        /// Fluxze-to-Fluxze E2E message): readable only on the web.
        case sealed
        case failed(String)
    }

    @State private var state: BodyState = .loading

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(email.displaySubject)
                    .font(.title3.bold())
                    .textSelection(.enabled)
                header
                Divider()
                bodyView
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.markRead(email)
            await loadBody()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(EmailText.name(of: email.sender)).font(.headline)
                Spacer()
                if let date = email.createdAt ?? email.listDate {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let sender = email.sender, sender.contains("<") {
                Text(EmailText.address(of: sender))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let receiver = email.receiver, !receiver.isEmpty {
                Text("To: \(receiver)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let mailbox = store.account(for: email.accountId) {
                Label(mailbox.label, systemImage: "tray")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private var bodyView: some View {
        switch state {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }.padding(.top, 24)
        case .loaded(let text) where text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            Text("This message has no text.").foregroundStyle(.secondary)
        case .loaded(let text):
            EmailBodyView(text: text)
        case .sealed:
            ContentUnavailableView {
                Label("Encrypted for your browser", systemImage: "lock")
            } description: {
                Text("This message is stored encrypted with your browser's key, and Fluxze couldn't fetch a fresh copy from your mail provider. Read it in Fluxze on the web, or reconnect this mailbox there.")
            } actions: {
                Link("Open in Fluxze", destination: Config.webURL("/emails"))
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load this message", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await loadBody() } }
            }
        }
    }

    private func loadBody() async {
        state = .loading
        do {
            if let text = try await store.body(of: email) {
                state = .loaded(text)
            } else {
                state = .sealed
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// Renders an email body: HTML in a web view with scripts off (links open in
/// Safari), plain text as text. Sizes itself to its content so the whole
/// screen scrolls as one.
struct EmailBodyView: View {
    let text: String
    @State private var height: CGFloat = 200

    var body: some View {
        if EmailText.isHTML(text) {
            HTMLView(html: text, height: $height)
                .frame(height: height)
        } else {
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct HTMLView: UIViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.dataDetectorTypes = [.link, .phoneNumber]
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        view.isOpaque = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(Self.document(html), baseURL: nil)
    }

    /// Fits the email to the phone's width and follows light/dark mode, without
    /// overriding the email's own colours where it sets them.
    static func document(_ html: String) -> String {
        """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <style>
        body { margin: 0; font: -apple-system-body; word-wrap: break-word; }
        img, table { max-width: 100% !important; height: auto; }
        pre { white-space: pre-wrap; }
        </style></head><body>\(html)</body></html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: String?
        @Binding var height: CGFloat

        init(height: Binding<CGFloat>) {
            _height = height
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Scripts are off for the page, but the app may still evaluate.
            webView.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] value, _ in
                if let h = value as? CGFloat, h > 0 {
                    DispatchQueue.main.async { self?.height = h }
                }
            }
        }

        /// The first load is the email itself; any link the reader taps opens
        /// in Safari rather than inside the app.
        func webView(_ webView: WKWebView,
                     decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
