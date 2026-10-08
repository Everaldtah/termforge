import LinuxCore
import QuartzCore
import XCTest

/// Installs the pinned root into the app's data container (cached across runs) and boots
/// the Linux layer once per test process. Used by every simulator test that needs Linux.
@MainActor
enum LinuxTestSupport {
    static let pinURL = URL(string: "https://github.com/Everaldtah/termforge/releases/download/rootfs-alpine-x86/alpine-x86.tar.gz")!
    static let pinSHA = "8d7a36ce70500b7e9917c7e9adf2bced1b8b0c88053037018e069f3520c05a0c"
    static let env = ["PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "TERM": "xterm-256color"]

    static var roots: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TermForge/test-roots", isDirectory: true)
    }

    static var host: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    static func metric(_ name: String, _ ms: Double) {
        print(String(format: "METRIC %@ %.0f ms", name, ms))
    }

    static func installedRoot() async throws -> URL {
        let fakefs = roots.appendingPathComponent("alpine-x86", isDirectory: true)
        let marker = fakefs.appendingPathComponent(".termforge-installed")
        if (try? String(contentsOf: marker, encoding: .utf8)) == pinSHA { return fakefs }
        try FileManager.default.createDirectory(at: roots, withIntermediateDirectories: true)
        let t0 = CACurrentMediaTime()
        let (tmp, response) = try await URLSession.shared.download(from: pinURL)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        metric("linux.rootfs.download", (CACurrentMediaTime() - t0) * 1000)
        let tar = roots.appendingPathComponent("alpine-x86.tar.gz")
        try? FileManager.default.removeItem(at: tar)
        try FileManager.default.moveItem(at: tmp, to: tar)
        let t1 = CACurrentMediaTime()
        try? FileManager.default.removeItem(at: fakefs)
        let runtime = LinuxRuntime.shared
        try await Task.detached { try runtime.importRootfs(tarGz: tar, into: fakefs) }.value
        metric("linux.rootfs.import", (CACurrentMediaTime() - t1) * 1000)
        try pinSHA.write(to: marker, atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: tar)
        return fakefs
    }

    static func ensureBooted() async throws {
        let runtime = LinuxRuntime.shared
        guard !runtime.booted else { return }
        let fakefs = try await installedRoot()
        try FileManager.default.createDirectory(at: host, withIntermediateDirectories: true)
        let t0 = CACurrentMediaTime()
        try runtime.boot(fakefsDir: fakefs, hostDir: host, temporaryDir: FileManager.default.temporaryDirectory)
        metric("linux.boot", (CACurrentMediaTime() - t0) * 1000)
    }

    /// Runs a command in a pty session and returns (exit code, output).
    static func session(_ cmd: String, cwd: String = "/root") async throws -> (Int32, String) {
        let one = try LinuxRuntime.shared.startSession(argv: ["/bin/sh", "-c", cmd], env: env, cwd: cwd, cols: 80, rows: 24)
        var got = Data()
        var rc: Int32 = -1
        let fin = XCTestExpectation(description: cmd)
        one.onOutput = { got.append($0) }
        one.onExit = { c in rc = c; fin.fulfill() }
        await XCTWaiter().fulfillment(of: [fin], timeout: 120)
        return (rc, String(decoding: got, as: UTF8.self))
    }
}

/// Boots the Linux layer in the simulator with the pinned Alpine root, then runs the
/// acceptance commands on a pty and through piped exec. Needs network on first run.
@MainActor
final class SimulatorLinuxTests: XCTestCase {
    func testBootShellAndExec() async throws {
        let runtime = LinuxRuntime.shared
        let host = LinuxTestSupport.host
        try await LinuxTestSupport.ensureBooted()
        try "from the host\n".write(to: host.appendingPathComponent("hello.txt"), atomically: true, encoding: .utf8)
        print("LINUX| \(runtime.version)")

        // one pty session: bash, python3, git, rg, the host mount
        let script = "echo bash=$BASH_VERSION; python3 -c 'print(\"py\", 1+1)'; git --version; rg --version | head -1; cat /mnt/termforge/hello.txt; exit 3"
        let t1 = CACurrentMediaTime()
        let bash = try runtime.startSession(argv: ["/bin/bash", "-c", script], env: LinuxTestSupport.env, cwd: "/root", cols: 80, rows: 24)
        var output = Data()
        var exitCode: Int32 = -1
        let done = expectation(description: "session exit")
        bash.onOutput = { output.append($0) }
        bash.onExit = { c in exitCode = c; done.fulfill() }
        await fulfillment(of: [done], timeout: 120)
        LinuxTestSupport.metric("linux.session.bashPythonGitRg", (CACurrentMediaTime() - t1) * 1000)
        let text = String(decoding: output, as: UTF8.self)
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" }) { print("LINUX| \(line)") }
        XCTAssertEqual(exitCode, 3)
        XCTAssertTrue(text.contains("bash=5."), text)
        XCTAssertTrue(text.contains("py 2"), text)
        XCTAssertTrue(text.contains("git version"), text)
        XCTAssertTrue(text.contains("ripgrep"), text)
        XCTAssertTrue(text.contains("from the host"), text)

        // device nodes as iOS sees them
        let (_, dev) = try await LinuxTestSupport.session("stat -c '%n %F %t:%T' /dev/null /dev/zero; cat /dev/null && echo null-ok")
        print("LINUX| \(dev.replacingOccurrences(of: "\r\n", with: " | "))")
        XCTAssertTrue(dev.contains("null-ok"), dev)

        // exec with pipes: git init + commit in the shared folder, stdout/stderr apart
        let project = host.appendingPathComponent("exec-project", isDirectory: true)
        try? FileManager.default.removeItem(at: project)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let t2 = CACurrentMediaTime()
        var out = Data(), err = Data()
        let exited = expectation(description: "exec exit")
        var code: Int32 = -1
        let exec = try runtime.exec(argv: ["/bin/sh", "-c", "git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m first && git log --oneline && echo warn >&2"],
                                    env: LinuxTestSupport.env, cwd: "/mnt/termforge/exec-project",
                                    stdout: { out.append($0) }, stderr: { err.append($0) },
                                    completion: { c in code = c; exited.fulfill() })
        exec.closeStdin()
        await fulfillment(of: [exited], timeout: 120)
        LinuxTestSupport.metric("linux.exec.gitInitCommit", (CACurrentMediaTime() - t2) * 1000)
        XCTAssertEqual(code, 0, String(decoding: err, as: UTF8.self))
        XCTAssertTrue(String(decoding: out, as: UTF8.self).contains("first"))
        XCTAssertEqual(String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines), "warn")
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent(".git/HEAD").path), "the commit landed in the host folder")
    }
}
