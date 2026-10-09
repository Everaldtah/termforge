import XCTest
@testable import TermForge

/// The PC tab's WebSocket PTY client against a real bridge (tools/pc-bridge) that CI starts
/// on the runner with a shell as the program. Skips when PC_BRIDGE_URL / PC_BRIDGE_TOKEN
/// are not in the test environment.
final class SimulatorPCTests: XCTestCase {
    func testPCSessionRunsAShellOnTheBridge() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["PC_BRIDGE_URL"], let token = env["PC_BRIDGE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("no PC bridge: set PC_BRIDGE_URL and PC_BRIDGE_TOKEN")
        }
        let session = try PCSession(baseURL: url, token: token, cmd: "shell", cwd: nil, cols: 100, rows: 30, continueSession: false)
        let state = State()
        session.onHello = { info in state.set { $0.hello = info["name"] as? String } }
        session.onData = { data in state.set { $0.output += String(decoding: data, as: UTF8.self) } }
        session.onExit = { code, error in state.set { $0.exit = (code, error) } }
        session.connect()

        try await wait(10) { state.get().hello != nil }
        session.write(Data("echo hello-from-pc\r".utf8))
        try await wait(15) { state.get().output.replacingOccurrences(of: "echo hello-from-pc", with: "").contains("hello-from-pc") }
        session.resize(cols: 120, rows: 40)
        session.write(Data("exit\r".utf8))
        try await wait(15) { state.get().exit != nil }
        let final = state.get()
        for line in final.output.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) { print("PC| \(line)") }
        XCTAssertEqual(final.exit?.0, 0, String(describing: final.exit))
        XCTAssertNil(final.exit?.1)

        // a wrong token is refused before any PTY starts
        let bad = try PCSession(baseURL: url, token: "nope", cmd: "shell", cwd: nil, cols: 80, rows: 24, continueSession: false)
        let badState = State()
        bad.onExit = { code, error in badState.set { $0.exit = (code, error) } }
        bad.connect()
        try await wait(15) { badState.get().exit != nil }
        XCTAssertNotNil(badState.get().exit?.1)
    }

    private func wait(_ seconds: Double, until done: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline, !done() { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(done(), "timed out after \(seconds) s")
    }

    private final class State: @unchecked Sendable {
        struct Values {
            var hello: String?
            var output = ""
            var exit: (Int?, String?)?
        }
        private var values = Values()
        private let lock = NSLock()
        func set(_ f: (inout Values) -> Void) { lock.lock(); f(&values); lock.unlock() }
        func get() -> Values { lock.lock(); defer { lock.unlock() }; return values }
    }
}
