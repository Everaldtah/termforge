import AuthenticationServices
import UIKit

/// Opens URLs that programs ask a browser to open (`xdg-open <url>` from the child_process shim).
///
/// Claude Code's sign-in redirects to http://localhost:<port>/callback, served by Claude Code
/// itself inside this app. ASWebAuthenticationSession keeps TermForge in the foreground while
/// the user signs in, so that local server can answer; Safari would suspend the app. When the
/// redirect completes, the user closes the sheet. Claude Code also prints a paste-a-code
/// fallback that works without any of this.
@MainActor
final class WebAuth: NSObject, @preconcurrency ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuth()

    private var current: ASWebAuthenticationSession?

    func open(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http" else { return }
        if url.path.lowercased().contains("oauth") {
            startAuthSession(url)
        } else {
            UIApplication.shared.open(url)
        }
    }

    private func startAuthSession(_ url: URL) {
        current?.cancel()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "termforge") { [weak self] _, _ in
            self?.current = nil
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        current = session
        session.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}
