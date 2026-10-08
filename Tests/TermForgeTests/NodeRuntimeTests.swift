import NodeCore
import QuartzCore
import XCTest

/// Runs against the real nodejs-mobile runtime the host app starts at launch.
/// Lines starting with "METRIC" are collected by CI into the performance report.
@MainActor
final class NodeRuntimeTests: XCTestCase {
    private var runtime: NodeRuntime { .shared }

    override func setUp() async throws {
        let deadline = Date().addingTimeInterval(60)
        while case .idle = runtime.state, Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let hello = try await runtime.waitUntilReady()
        XCTAssertTrue(hello.jitless, "nodejs-mobile must run V8 without JIT")
    }

    private func metric(_ name: String, _ ms: Double) {
        print(String(format: "METRIC %@ %.2f ms", name, ms))
    }

    func testRuntimeStartsAndAnswersPings() async throws {
        if let ms = runtime.timings.startupMs { metric("runtime.startToHello", ms) }
        var samples: [Double] = []
        for _ in 0..<30 { samples.append(try await runtime.ping()) }
        samples.sort()
        metric("control.roundTrip.median", samples[15])
        metric("control.roundTrip.p95", samples[28])
        let status = try await runtime.status()
        XCTAssertTrue(status.node.hasPrefix("v18."))
        XCTAssertNotNil(status.packages["claude-code"])
    }

    /// A raw-mode program: TTY detection, argv, cwd, resize, SIGINT and exit codes.
    func testTTYProgramLifecycle() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("probe.mjs")
        try """
        const { stdin, stdout } = process;
        stdout.write(`tty=${stdin.isTTY}/${stdout.isTTY} cols=${stdout.columns} rows=${stdout.rows} argv=${process.argv.slice(2).join(',')}\\n`);
        stdout.write(`cwd=${process.cwd()}\\n`);
        stdout.on('resize', () => stdout.write(`RESIZE ${stdout.columns}x${stdout.rows}\\n`));
        process.on('SIGINT', () => stdout.write('GOT SIGINT\\n'));
        stdin.setRawMode(true);
        stdin.on('data', (d) => { stdout.write(`KEY:${Buffer.from(d).toString('hex')}\\n`); if (d.includes(0x71)) process.exit(7); });
        stdout.write('READY\\n');
        """.write(to: script, atomically: true, encoding: .utf8)

        let session = try runtime.openSession(SessionSpec(kind: .script, cols: 100, rows: 30, cwd: dir.path, argv: ["a", "b"], entry: script.path))
        let screen = Screen(session)
        try await screen.wait(for: "READY")
        if let ms = session.firstOutputMs { metric("script.openToFirstOutput", ms) }
        XCTAssertTrue(screen.text.contains("tty=true/true cols=100 rows=30 argv=a,b"))
        XCTAssertTrue(screen.text.contains("cwd=\(dir.path)"))
        XCTAssertTrue(screen.text.contains("\r\n"), "ONLCR")

        var echo: [Double] = []
        for _ in 0..<20 {
            let before = screen.text.components(separatedBy: "KEY:6b").count
            let t0 = CACurrentMediaTime()
            session.write("k")
            try await screen.wait { $0.components(separatedBy: "KEY:6b").count > before }
            echo.append((CACurrentMediaTime() - t0) * 1000)
        }
        echo.sort()
        metric("keystroke.programEcho.median", echo[10])
        metric("keystroke.programEcho.p95", echo[18])

        session.resize(cols: 120, rows: 40)
        try await screen.wait(for: "RESIZE 120x40")
        session.signal(2)
        try await screen.wait(for: "GOT SIGINT")
        session.write("q")
        let exit = try await screen.waitForExit()
        XCTAssertEqual(exit.code, 7)
    }

    func testNodeREPL() async throws {
        let session = try runtime.openSession(SessionSpec(kind: .repl, cols: 80, rows: 24))
        let screen = Screen(session)
        try await screen.wait(for: "> ")
        if let ms = session.firstOutputMs { metric("repl.openToPrompt", ms) }
        session.write("6*7\r")
        try await screen.wait(for: "42")
        session.write(".exit\r")
        let exit = try await screen.waitForExit()
        XCTAssertEqual(exit.code, 0)
    }

    func testClaudeWithoutInstallReportsNotInstalled() async throws {
        let status = try await runtime.status()
        try XCTSkipIf(status.packages["claude-code"]?.installed != nil, "Claude Code is installed in this simulator")
        let session = try runtime.openSession(SessionSpec(kind: .claude))
        let exit = try await Screen(session).waitForExit()
        XCTAssertTrue(exit.notInstalled)
    }
}

/// Collects a session's output; waiters resume the moment matching output arrives.
@MainActor
private final class Screen {
    private(set) var text = ""
    private var exitInfo: SessionExit?
    private var waiters: [(id: UUID, predicate: (String) -> Bool, cont: CheckedContinuation<Void, Error>)] = []

    init(_ session: NodeSession) {
        session.onData = { [weak self] bytes in
            guard let self else { return }
            self.text += String(decoding: Array(bytes), as: UTF8.self)
            self.check()
        }
        session.onExit = { [weak self] info in
            self?.exitInfo = info
            self?.check()
        }
    }

    func wait(for needle: String, timeout: TimeInterval = 20) async throws {
        try await wait(timeout: timeout) { $0.contains(needle) }
    }

    func wait(timeout: TimeInterval = 20, _ predicate: @escaping (String) -> Bool) async throws {
        if predicate(text) { return }
        let id = UUID()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            waiters.append((id, predicate, cont))
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self, let i = self.waiters.firstIndex(where: { $0.id == id }) else { return }
                let w = self.waiters.remove(at: i)
                w.cont.resume(throwing: TimeoutError(screen: self.text))
            }
        }
    }

    func waitForExit(timeout: TimeInterval = 20) async throws -> SessionExit {
        try await wait(timeout: timeout) { [weak self] _ in self?.exitInfo != nil }
        return exitInfo!
    }

    private func check() {
        let ready = waiters.filter { $0.predicate(text) }
        waiters.removeAll { w in ready.contains { $0.id == w.id } }
        ready.forEach { $0.cont.resume() }
    }

    struct TimeoutError: Error, CustomStringConvertible {
        let screen: String
        var description: String { "timed out; screen so far:\n\(screen)" }
    }
}
