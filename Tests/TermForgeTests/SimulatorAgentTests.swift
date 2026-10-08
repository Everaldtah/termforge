import NodeCore
import XCTest

/// The Agent tab's program (nodejs-project/agent) inside the simulator's jitless runtime:
/// it loads, refuses to start without a key, and with a key reaches its prompt, sends a
/// request through the fetch shim and reports a connection failure for an unreachable API.
/// No network, no real key: the API base is a closed local port.
@MainActor
final class SimulatorAgentTests: XCTestCase {
    func testAgentLoadsAndReportsUnreachableAPI() async throws {
        let runtime = NodeRuntime.shared
        let deadline = Date().addingTimeInterval(60)
        while case .idle = runtime.state, Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        _ = try await runtime.waitUntilReady()

        let project = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("agent-project", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)

        // without a key: a clear message and exit code 2
        let noKey = try runtime.openSession(SessionSpec(kind: .agent, cols: 100, rows: 30, cwd: project.path, env: ["ANTHROPIC_API_KEY": ""]))
        var noKeyOutput = ""
        var noKeyExit: SessionExit?
        noKey.onData = { noKeyOutput += String(decoding: Array($0), as: UTF8.self) }
        noKey.onExit = { noKeyExit = $0 }
        var until = Date().addingTimeInterval(60)
        while Date() < until, noKeyExit == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(noKeyExit?.code, 2, noKeyOutput)
        XCTAssertTrue(noKeyOutput.contains("No Anthropic API key"), noKeyOutput)

        // with a key: prompt, then a request that fails to connect (port 9 is closed)
        let env = ["ANTHROPIC_API_KEY": "sk-ant-test", "TERMFORGE_API_BASE": "http://127.0.0.1:9", "TERMFORGE_AGENT_MODEL": "claude-opus-5-5"]
        let session = try runtime.openSession(SessionSpec(kind: .agent, cols: 100, rows: 30, cwd: project.path, env: env))
        var output = ""
        var exited: SessionExit?
        session.onData = { output += String(decoding: Array($0), as: UTF8.self) }
        session.onExit = { exited = $0 }
        until = Date().addingTimeInterval(60)
        while Date() < until, exited == nil, !output.contains("❯") { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(output.contains("TermForge agent"), output)
        XCTAssertTrue(output.contains("Claude Opus 5.5"), output)
        session.write(Array("hello\r".utf8))
        // three retries (1 + 2 + 4 s) and then the final error line
        let failures = { output.components(separatedBy: "connection failed").count - 1 }
        until = Date().addingTimeInterval(90)
        while Date() < until, exited == nil, failures() < 4 { try await Task.sleep(nanoseconds: 50_000_000) }
        for line in output.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) { print("AGENT| \(line)") }
        XCTAssertNil(exited, "the agent must survive an unreachable API")
        XCTAssertEqual(failures(), 4, output)
        session.write(Array("/exit\r".utf8))
        until = Date().addingTimeInterval(30)
        while Date() < until, exited == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(exited?.code, 0)
    }
}
