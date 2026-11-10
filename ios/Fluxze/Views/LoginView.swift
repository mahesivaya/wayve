import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var appState: AppState
    @State private var identifier = ""
    @State private var password = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var verifyMessage: String?

    private var canSubmit: Bool {
        !identifier.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty && !isWorking
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        Text("Sign in to Fluxze")
                            .font(.title2.bold())
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }

                if let notice = appState.notice {
                    Section { Text(notice).foregroundStyle(.secondary) }
                }

                Section {
                    TextField("Email or username", text: $identifier)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { if canSubmit { Task { await signIn() } } }
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking { ProgressView() } else { Text("Sign in").bold() }
                            Spacer()
                        }
                    }
                    .disabled(!canSubmit)
                }

                Section {
                    Link("Forgot password?", destination: Config.webURL("/forgot-password"))
                    Link("New to Fluxze? Create an account", destination: Config.webURL("/register"))
                }
            }
            .navigationDestination(isPresented: Binding(
                get: { verifyMessage != nil },
                set: { if !$0 { verifyMessage = nil } }
            )) {
                VerifyEmailView(email: identifier, message: verifyMessage ?? "") {
                    verifyMessage = nil
                    await signIn()
                }
            }
        }
    }

    private func signIn() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            switch try await AuthService(api: appState.api).login(identifier: identifier, password: password) {
            case .signedIn(let token):
                await appState.signIn(token: token)
            case .emailUnverified(let message):
                verifyMessage = message
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
