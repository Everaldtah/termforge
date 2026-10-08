import NodeCore
import QuartzCore
import XCTest

/// Installs the pinned Claude Code from registry.npmjs.org inside the simulator's runtime and
/// times its startup to the first screen. Runs after NodeRuntimeTests (alphabetical class
/// order), which checks the NOT_INSTALLED path first. Needs network.
@MainActor
final class SimulatorClaudeCodeTests: XCTestCase {
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

        let home = FileManager.default.temporaryDirectory.appendingPathComponent("cc-home-\(UUID().uuidString)")
        let project = home.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let session = try runtime.openSession(SessionSpec(kind: .claude, cols: 100, rows: 32, cwd: project.path, platform: "linux"))

        var output = ""
        var exited: SessionExit?
        session.onData = { output += String(decoding: Array($0), as: UTF8.self) }
        session.onExit = { exited = $0 }
        let firstScreen = ["Choose the text style", "Welcome to Claude Code", "Select login method"]
        let until = Date().addingTimeInterval(90)
        var plain = ""
        while Date() < until, exited == nil {
            plain = output.replacingOccurrences(of: "\u{1b}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            if firstScreen.contains(where: plain.contains) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let shown = firstScreen.first(where: plain.contains)
        XCTAssertNotNil(shown, "Claude Code did not reach its first screen (exit: \(String(describing: exited))). Output:\n\(plain.suffix(2000))")
        if shown != nil {
            print(String(format: "METRIC claude.openToFirstScreen %.0f ms", (CACurrentMediaTime() - session.openedAt) * 1000))
        }
        if let ms = session.firstOutputMs { print(String(format: "METRIC claude.openToFirstOutput %.0f ms", ms)) }
        for (name, ms) in session.metrics.sorted(by: { $0.key < $1.key }) {
            print(String(format: "METRIC claude.%@ %.0f ms", name, ms))
        }
        session.close()
    }
}
