import SwiftUI
import Translation
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
    @State private var showDetails = false
    @State private var unlocking = false
    /// Loaded the first time the details open; "" when there is none.
    @State private var cc: String?
    @State private var composing: ComposeView.Mode?
    @State private var translating = false
    @State private var confirmDelete = false
    @State private var actionError: String?
    @Environment(\.dismiss) private var dismiss

    /// The body as plain text, for quoting, translating and sharing.
    private var bodyText: String? {
        if case .loaded(let text) = state { return EmailText.plainText(text) }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(email.displaySubject)
                    .font(.title3.bold())
                    .textSelection(.enabled)
                header
                Divider()
                bodyView
                if email.accountId != nil { bottomActions }
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.markRead(email)
            await loadBody()
        }
        .sheet(isPresented: $unlocking) {
            UnlockKeyView { Task { await loadBody() } }
        }
        .sheet(item: $composing) { mode in
            ComposeView(store: store, original: email, mode: mode, originalText: bodyText)
        }
        .modifier(TranslateSheet(isPresented: $translating, text: bodyText ?? ""))
        .confirmationDialog("Move this email to Trash?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { run { try await store.trash(email); dismiss() } }
        }
        .alert("Something went wrong",
               isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    /// ☆ ↩ ⋮ beside the sender, like Gmail.
    private var actions: some View {
        HStack(spacing: 18) {
            let starred = store.isStarred(email.id)
            Button {
                run { try await store.setStarred(email, !starred) }
            } label: {
                Image(systemName: starred ? "star.fill" : "star")
                    .foregroundStyle(starred ? Color.yellow : Color.primary)
            }
            .accessibilityLabel(starred ? "Unstar" : "Star")

            Button { composing = .reply } label: { Image(systemName: "arrowshape.turn.up.left") }
                .accessibilityLabel("Reply")
                .disabled(email.accountId == nil)

            Menu {
                Section {
                    Button { composing = .reply } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    Button { composing = .forward } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
                }
                .disabled(email.accountId == nil)
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                    Button {
                        run { try await store.markUnread(email); dismiss() }
                    } label: { Label("Mark as unread", systemImage: "envelope.badge") }
                }
                Section {
                    if #available(iOS 17.4, *) {
                        Button { translating = true } label: { Label("Translate", systemImage: "translate") }
                            .disabled(bodyText == nil)
                    }
                    Button { print() } label: { Label("Print", systemImage: "printer") }
                        .disabled(bodyText == nil)
                    if let bodyText {
                        ShareLink(item: shareText(bodyText), subject: Text(email.displaySubject)) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .rotationEffect(.degrees(90))
                    .frame(width: 24, height: 24)
            }
            .accessibilityLabel("More")
        }
        .font(.body)
        .foregroundStyle(.primary)
    }

    /// Reply and Forward under the message, like the end of a Gmail email.
    private var bottomActions: some View {
        HStack(spacing: 10) {
            Button { composing = .reply } label: {
                Label("Reply", systemImage: "arrowshape.turn.up.left")
                    .frame(maxWidth: .infinity)
            }
            Button { composing = .forward } label: {
                Label("Forward", systemImage: "arrowshape.turn.up.right")
                    .frame(maxWidth: .infinity)
            }
        }
        .font(.subheadline)
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.regular)
        .tint(.primary)
        .padding(.top, 16)
    }

    /// Runs an action, showing its error instead of failing silently.
    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { actionError = error.localizedDescription }
        }
    }

    private func shareText(_ body: String) -> String {
        "From: \(email.sender ?? "")\nSubject: \(email.displaySubject)\n\n\(body)"
    }

    private func print() {
        guard case .loaded(let text) = state else { return }
        let header = "<h3>\(Self.escape(email.displaySubject))</h3><p><b>From:</b> \(Self.escape(email.sender ?? ""))<br><b>To:</b> \(Self.escape(email.receiver ?? ""))</p><hr>"
        let content = EmailText.isHTML(text) ? text : "<pre style=\"white-space:pre-wrap\">\(Self.escape(text))</pre>"
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo.printInfo()
        info.jobName = email.displaySubject
        controller.printInfo = info
        controller.printFormatter = UIMarkupTextPrintFormatter(markupText: header + content)
        controller.present(animated: true)
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(EmailText.name(of: email.sender)).font(.headline)
                    if let sender = email.sender, sender.contains("<") {
                        Text(EmailText.address(of: sender))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let date = email.createdAt ?? email.listDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                actions
            }
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showDetails.toggle() }
                if showDetails, cc == nil { Task { await loadDetails() } }
            } label: {
                HStack(spacing: 3) {
                    Text(EmailsStore.recipientSummary(email.receiver))
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(showDetails ? 180 : 0))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showDetails ? "Hide details" : "Show details")
            if showDetails { details }
        }
        .textSelection(.enabled)
    }

    /// Gmail-style header details: who, when, and which mailbox.
    private var details: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 10, verticalSpacing: 6) {
            detailRow("from", email.sender)
            detailRow("to", email.receiver)
            detailRow("cc", cc?.isEmpty == false ? cc : nil)
            detailRow("date", (email.createdAt ?? email.listDate)?
                .formatted(date: .abbreviated, time: .shortened))
            detailRow("mailbox", store.account(for: email.accountId)?.email)
        }
        .font(.caption)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func detailRow(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            GridRow {
                Text("\(label):")
                    .foregroundStyle(.secondary)
                    .gridColumnAlignment(.trailing)
                Text(value)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Cc loads the first time the details open; a failure leaves it out.
    private func loadDetails() async {
        cc = (try? await store.detail(of: email))?.cc ?? ""
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
                Label("Encrypted message", systemImage: "lock")
            } description: {
                Text(KeyVault.hasKey
                     ? "This message is encrypted with a key that isn't on this iPhone. Read it in Fluxze on the web."
                     : "This message is end-to-end encrypted. Unlock your key on this iPhone to read it here.")
            } actions: {
                if !KeyVault.hasKey {
                    Button("Unlock with recovery phrase") { unlocking = true }
                        .buttonStyle(.borderedProminent)
                }
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
            // The width is passed in so turning the phone re-fits the email.
            GeometryReader { geo in
                HTMLView(html: text, width: geo.size.width, height: $height)
            }
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
    /// The space available; when it changes (the phone turns), the email is
    /// fitted again.
    var width: CGFloat = 0
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
        let coordinator = context.coordinator
        if coordinator.loaded != html {
            coordinator.loaded = html
            coordinator.width = width
            view.loadHTMLString(Self.document(html), baseURL: nil)
        } else if abs(coordinator.width - width) > 1 {
            coordinator.width = width
            // Let the web view take its new size before measuring.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak view] in
                if let view { coordinator.refit(view) }
            }
        }
    }

    /// Fits the email to the phone's width and follows light/dark mode, without
    /// overriding the email's own colours where it sets them.
    static func document(_ html: String) -> String {
        """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <style>
        body { margin: 0; font: -apple-system-body; word-wrap: break-word; overflow-x: hidden; }
        img { max-width: 100%; height: auto; }
        pre { white-space: pre-wrap; }
        </style></head><body><div id="fz">\(html)</div></body></html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: String?
        var width: CGFloat = 0
        @Binding var height: CGFloat

        init(height: Binding<CGFloat>) {
            _height = height
        }

        /// Fits a wide email to the screen, as Mail and Gmail do: most HTML
        /// mail is a fixed ~600px layout, so if the content is wider than the
        /// view it's scaled down to fit, then the view takes its new height.
        /// Run again shortly after load, for images that size themselves late.
        /// The email is laid out at its natural width inside #fz, then scaled
        /// as a whole (a transform, not zoom, so text keeps its own spacing).
        static let fitScript = """
        (function () {
          var wrap = document.getElementById('fz');
          wrap.style.transform = '';
          wrap.style.width = '';
          var view = window.innerWidth;
          var wide = Math.max(wrap.scrollWidth, document.documentElement.scrollWidth);
          if (wide > view + 1) {
            var scale = view / wide;
            wrap.style.width = wide + 'px';
            wrap.style.transformOrigin = '0 0';
            wrap.style.transform = 'scale(' + scale + ')';
            return Math.ceil(wrap.getBoundingClientRect().height) + 4;
          }
          return document.documentElement.scrollHeight;
        })()
        """

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            fit(webView)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self, weak webView] in
                if let webView { self?.fit(webView) }
            }
        }

        func refit(_ webView: WKWebView) { fit(webView) }

        private func fit(_ webView: WKWebView) {
            // Scripts are off for the page, but the app may still evaluate.
            webView.evaluateJavaScript(Self.fitScript) { [weak self] value, _ in
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

extension ComposeView.Mode: Identifiable {
    var id: Self { self }
}

/// iOS's built-in Translate sheet (iOS 17.4+); nothing on older systems.
private struct TranslateSheet: ViewModifier {
    @Binding var isPresented: Bool
    let text: String

    func body(content: Content) -> some View {
        if #available(iOS 17.4, *) {
            content.translationPresentation(isPresented: $isPresented, text: text)
        } else {
            content
        }
    }
}
