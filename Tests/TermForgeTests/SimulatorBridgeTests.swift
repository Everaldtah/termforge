import LinuxCore
import NodeCore
import QuartzCore
import XCTest
@testable import TermForge

/// The acceptance path end to end inside the simulator: a Node session's child_process
/// calls go through the worker's Linux tier, the supervisor, Swift's ExecBackend and
/// iSH, and `git init && git commit` lands in the shared Documents folder.
/// Runs after SimulatorLinuxTests (alphabetical), which has booted the Linux layer.
@MainActor
final class SimulatorBridgeTests: XCTestCase {
    func testNodeChildProcessRunsGitInsideLinux() async throws {
        let node = NodeRuntime.shared
        let linux = LinuxRuntime.shared
        let deadline = Date().addingTimeInterval(60)
        while case .idle = node.state, Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        _ = try await node.waitUntilReady()
        try await LinuxTestSupport.ensureBooted()
        node.execBackend = LinuxExecBackend(runtime: linux)

        let home = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let project = home.appendingPathComponent("bridge-project", isDirectory: true)
        try? FileManager.default.removeItem(at: project)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let script = project.appendingPathComponent("probe.mjs")
        try """
        import { execFileSync, execFile } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        import { promisify } from 'node:util';
        const run = promisify(execFile);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        writeFileSync('hello.txt', 'written by node\\n');
        say({ t: 'uname', out: execFileSync('uname', ['-sm'], { encoding: 'utf8' }).trim() });
        await run('git', ['init', '-q']);
        await run('git', ['add', 'hello.txt']);
        await run('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'first']);
        const { stdout } = await run('git', ['log', '--oneline']);
        say({ t: 'log', out: stdout.trim() });
        const { stdout: rg } = await run('rg', ['-n', 'written', 'hello.txt']);
        say({ t: 'rg', out: rg.trim() });
        say({ t: 'done' });
        """.write(to: script, atomically: true, encoding: .utf8)

        let t0 = CACurrentMediaTime()
        let session = try node.openSession(SessionSpec(kind: .script, cols: 80, rows: 24, cwd: project.path, entry: script.path))
        var output = ""
        var execs: [String] = []
        var exited: SessionExit?
        session.onData = { output += String(decoding: Array($0), as: UTF8.self) }
        session.onEvent = { e in if e.event == "exec" { execs.append("\(e.tier ?? "?"): \(([e.file ?? ""] + (e.args ?? [])).joined(separator: " ")) -> \(e.code.map(String.init) ?? "")") } }
        session.onExit = { exited = $0 }
        let until = Date().addingTimeInterval(120)
        while Date() < until, exited == nil, !output.contains("\"t\":\"done\"") {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        print(String(format: "METRIC bridge.nodeGitInitCommitViaLinux %.0f ms", (CACurrentMediaTime() - t0) * 1000))
        for line in output.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) { print("BRIDGE| \(line)") }
        for e in execs { print("BRIDGE| exec \(e)") }
        XCTAssertTrue(output.contains("\"t\":\"done\""), "probe did not finish; exit: \(String(describing: exited))\n\(output)")
        XCTAssertTrue(output.contains("Linux i686"), output)
        XCTAssertTrue(output.contains("first"), output)
        XCTAssertTrue(output.contains("1:written by node"), output)
        XCTAssertTrue(execs.allSatisfy { $0.hasPrefix("linux:") }, execs.joined(separator: "\n"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent(".git/HEAD").path))
        session.close()
    }
}
