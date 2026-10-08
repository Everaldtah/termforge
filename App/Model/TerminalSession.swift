import Foundation
import NodeCore
import TerminalUI

/// A tab: one terminal screen plus the Node session currently attached to it.
/// Restarting a finished program reuses the screen, like a terminal emulator would.
@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id = UUID()
    let kind: SessionKind
    let project: URL
    let controller: TerminalController

    @Published private(set) var title: String
    @Published private(set) var exit: SessionExit?
    @Published private(set) var running = false
    @Published private(set) var screenSnapshot = ""

    private(set) var node: NodeSession?
    private var resumeOnStart: Bool
    private var snapshotTimer: Timer?

    init(kind: SessionKind, project: URL, resume: Bool = false) {
        self.kind = kind
        self.project = project
        self.resumeOnStart = resume
        self.controller = TerminalController()
        switch kind {
        case .claude: title = "Claude · \(project.lastPathComponent)"
        case .repl: title = "Node"
        case .script: title = "Script"
        }
        controller.onInput = { [weak self] bytes in self?.node?.write(bytes) }
        controller.onResize = { [weak self] cols, rows in self?.node?.resize(cols: cols, rows: rows) }
        controller.onOpenLink = { url in WebAuth.shared.open(url) }
    }

    func start(runtime: NodeRuntime = .shared, apiKey: String?) {
        guard !running else { return }
        var env: [String: String] = [:]
        var argv: [String] = []
        if kind == .claude {
            if let apiKey, !apiKey.isEmpty { env["ANTHROPIC_API_KEY"] = apiKey }
            if resumeOnStart && Paths.hasClaudeConversation(cwd: project) { argv = ["--continue"] }
        }
        resumeOnStart = false
        let spec = SessionSpec(kind: kind, cols: controller.cols, rows: controller.rows, cwd: project.path, env: env,
                               argv: argv, platform: kind == .claude ? "linux" : nil)
        do {
            let node = try runtime.openSession(spec)
            self.node = node
            exit = nil
            running = true
            node.onData = { [weak self] bytes in self?.controller.feed(bytes) }
            node.onEvent = { event in
                if event.event == "open-url", let s = event.url, let url = URL(string: s) { WebAuth.shared.open(url) }
            }
            node.onExit = { [weak self] info in self?.finished(info) }
        } catch {
            finished(SessionExit(code: nil, error: error.localizedDescription, reason: "OPEN_FAILED", ms: nil))
        }
    }

    private func finished(_ info: SessionExit) {
        running = false
        exit = info
        if info.notInstalled { return }
        var line = "\r\n\u{1b}[2m[process exited"
        if let code = info.code { line += " with code \(code)" }
        if let error = info.error { line += ": \(error)" }
        line += "]\u{1b}[0m\r\n"
        controller.feed(text: line)
    }

    func restart(apiKey: String?) {
        node = nil
        start(apiKey: apiKey)
    }

    func close() {
        snapshotTimer?.invalidate()
        node?.close()
    }

    // MARK: quick actions

    func send(_ text: String) {
        node?.write(text)
    }

    func interrupt() {
        node?.write([0x03])
    }

    func escape() {
        node?.write([0x1b])
    }

    /// UI tests read the screen through this published copy.
    func startSnapshotting() {
        snapshotTimer?.invalidate()
        snapshotTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let text = self.controller.screenText()
                if text != self.screenSnapshot { self.screenSnapshot = text }
            }
        }
    }
}
