import Foundation
import LinuxCore
import NodeCore
import TerminalUI

/// What a tab runs: a program in the Node runtime, or a shell in the Linux layer.
enum TabKind: Codable, Equatable {
    case node(SessionKind)
    case linux

    var isClaude: Bool { self == .node(.claude) }
    var saveName: String {
        switch self {
        case .node(let k): return k.rawValue
        case .linux: return "linux"
        }
    }

    init(saveName: String) {
        if let k = SessionKind(rawValue: saveName) { self = .node(k) } else { self = .linux }
    }
}

/// A tab: one terminal screen plus the process currently attached to it.
/// Restarting a finished program reuses the screen, like a terminal emulator would.
@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id = UUID()
    let kind: TabKind
    let project: URL
    let controller: TerminalController

    @Published private(set) var title: String
    @Published private(set) var exit: SessionExit?
    @Published private(set) var running = false
    @Published private(set) var screenSnapshot = ""

    private(set) var node: NodeSession?
    private(set) var linux: LinuxSession?
    private var resumeOnStart: Bool
    private var snapshotTimer: Timer?

    init(kind: TabKind, project: URL, resume: Bool = false) {
        self.kind = kind
        self.project = project
        self.resumeOnStart = resume
        self.controller = TerminalController()
        switch kind {
        case .node(.claude): title = "Claude · \(project.lastPathComponent)"
        case .node(.agent): title = "Agent · \(project.lastPathComponent)"
        case .node(.repl): title = "Node"
        case .node(.script): title = "Script"
        case .linux: title = "Alpine"
        }
        controller.onInput = { [weak self] bytes in self?.write(bytes) }
        controller.onResize = { [weak self] cols, rows in
            self?.node?.resize(cols: cols, rows: rows)
            self?.linux?.resize(cols: cols, rows: rows)
        }
        controller.onOpenLink = { url in WebAuth.shared.open(url) }
    }

    func start(apiKey: String?) {
        guard !running else { return }
        switch kind {
        case .node(let sessionKind): startNode(sessionKind, apiKey: apiKey)
        case .linux: startLinux()
        }
    }

    private func startNode(_ sessionKind: SessionKind, apiKey: String?) {
        var env: [String: String] = [:]
        var argv: [String] = []
        if sessionKind == .claude {
            if let apiKey, !apiKey.isEmpty { env["ANTHROPIC_API_KEY"] = apiKey }
            if resumeOnStart && Paths.hasClaudeConversation(cwd: project) { argv = ["--continue"] }
        }
        if sessionKind == .agent {
            // the agent has no sign-in of its own: without a key the tab shows the key card instead
            guard let apiKey, !apiKey.isEmpty else {
                resumeOnStart = false
                finished(SessionExit(code: nil, error: "no API key", reason: "NOT_INSTALLED", ms: nil))
                return
            }
            env["ANTHROPIC_API_KEY"] = apiKey
            env["TERMFORGE_AGENT_MODEL"] = AgentSettings.model
            env["TERMFORGE_AGENT_EFFORT"] = AgentSettings.effort
        }
        resumeOnStart = false
        let spec = SessionSpec(kind: sessionKind, cols: controller.cols, rows: controller.rows, cwd: project.path, env: env,
                               argv: argv, platform: sessionKind == .claude ? "linux" : nil)
        do {
            let node = try NodeRuntime.shared.openSession(spec)
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

    /// A login shell in the Alpine root, started in the project's folder as seen from Linux.
    private func startLinux() {
        let guestCwd = Self.guestPath(for: project)
        let env = [
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root", "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "C.UTF-8",
            "TERMFORGE_HOME": LinuxRuntime.hostMountPoint,
        ]
        do {
            let session = try LinuxRuntime.shared.startSession(argv: ["/bin/bash", "-l"], env: env, cwd: guestCwd,
                                                               cols: controller.cols, rows: controller.rows)
            self.linux = session
            exit = nil
            running = true
            session.onOutput = { [weak self] data in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.controller.feed(Array(data)[...]) } }
            }
            session.onExit = { [weak self] code in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.finished(SessionExit(code: Int(code))) } }
            }
        } catch {
            finished(SessionExit(code: nil, error: error.localizedDescription, reason: error is LinuxError && (error as! LinuxError) == .notBooted ? "NOT_INSTALLED" : "OPEN_FAILED", ms: nil))
        }
    }

    /// Where a host folder under Documents appears inside the Linux root.
    static func guestPath(for hostURL: URL) -> String {
        let home = Paths.home.standardizedFileURL.path
        let path = hostURL.standardizedFileURL.path
        guard path == home || path.hasPrefix(home + "/") else { return LinuxRuntime.hostMountPoint }
        return LinuxRuntime.hostMountPoint + String(path.dropFirst(home.count))
    }

    private func write(_ bytes: [UInt8]) {
        if let node { node.write(bytes) } else { linux?.write(Data(bytes)) }
    }

    private func finished(_ info: SessionExit) {
        running = false
        exit = info
        node = nil
        linux = nil
        if info.notInstalled { return }
        var line = "\r\n\u{1b}[2m[process exited"
        if let code = info.code { line += " with code \(code)" }
        if let error = info.error { line += ": \(error)" }
        line += "]\u{1b}[0m\r\n"
        controller.feed(text: line)
    }

    func restart(apiKey: String?) {
        node = nil
        linux = nil
        start(apiKey: apiKey)
    }

    func close() {
        snapshotTimer?.invalidate()
        node?.close()
        linux?.hangup()
    }

    // MARK: quick actions

    func send(_ text: String) {
        write(Array(text.utf8))
    }

    func interrupt() {
        write([0x03])
    }

    func escape() {
        write([0x1b])
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
