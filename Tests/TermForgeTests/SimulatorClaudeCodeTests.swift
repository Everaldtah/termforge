import NodeCore
import QuartzCore
import XCTest

/// Installs the pinned Claude Code from registry.npmjs.org inside the simulator's runtime and
/// times its startup to the first screen. Runs after NodeRuntimeTests (alphabetical class
/// order), which checks the NOT_INSTALLED path first. Needs network.
/// Prints Claude Code's screen ("CLAUDE|") and every spawn attempt ("EXEC|") to the log.
@MainActor
final class SimulatorClaudeCodeTests: XCTestCase {
    private static let firstScreen = ["Choose the text style", "Welcome to Claude Code", "Select login method"]

    func testInstallThenStartClaudeCode() async throws {
        let runtime = NodeRuntime.shared
        let deadline = Date().addingTimeInterval(60)
        while case .idle = runtime.state, Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        _ = try await runtime.waitUntilReady()

        if try await runtime.status().packages["claude-code"]?.installed == nil {
            let t0 = CACurrentMediaTime()
            let result = try await runtime.install(package: "claude-code")
            print(String(format: "METRIC claude.install %.0f ms (node-side %.0f ms, %d files)",
                         (CACurrentMediaTime() - t0) * 1000, result.ms, result.written))
            XCTAssertTrue(result.skipped.allSatisfy { $0.path.hasPrefix("vendor/") })
        }

        let project = FileManager.default.temporaryDirectory.appendingPathComponent("cc-\(UUID().uuidString)/project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let session = try runtime.openSession(SessionSpec(kind: .claude, cols: 100, rows: 32, cwd: project.path, platform: "linux"))

        var output = ""
        var exited: SessionExit?
        var execs: [String] = []
        session.onData = { output += String(decoding: Array($0), as: UTF8.self) }
        session.onExit = { exited = $0 }
        session.onEvent = { e in
            guard e.event == "exec" else { return }
            execs.append("\(e.tier ?? "?"): " + ([e.file ?? ""] + (e.args ?? [])).joined(separator: " "))
        }
        let plainText = { Self.stripANSI(output) }
        let until = Date().addingTimeInterval(90)
        while Date() < until, exited == nil, !Self.firstScreen.contains(where: plainText().contains) {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 300_000_000)

        let plain = plainText()
        for line in plain.split(separator: "\n", omittingEmptySubsequences: false) { print("CLAUDE| \(line)") }
        for line in execs { print("EXEC| \(line)") }
        let shown = Self.firstScreen.first(where: plain.contains)
        XCTAssertNotNil(shown, "Claude Code did not reach its first screen (exit: \(String(describing: exited))); see CLAUDE| lines")
        if shown != nil {
            print(String(format: "METRIC claude.openToFirstScreen %.0f ms", (CACurrentMediaTime() - session.openedAt) * 1000))
        }
        if let ms = session.firstOutputMs { print(String(format: "METRIC claude.openToFirstOutput %.0f ms", ms)) }
        for (name, ms) in session.metrics.sorted(by: { $0.key < $1.key }) {
            print(String(format: "METRIC claude.%@ %.0f ms", name, ms))
        }
        session.close()
    }

    /// Drops CSI/OSC escape sequences and carriage returns so screen text can be searched.
    static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }
}
