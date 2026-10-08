import LinuxCore
import QuartzCore
import XCTest

/// Boots the Linux layer in the simulator with the pinned Alpine root (downloaded from this
/// project's releases, ~100 MB; cached in the app's data container across test runs), then
/// runs the acceptance commands. Prints METRIC lines for CI. Needs network on first run.
@MainActor
final class SimulatorLinuxTests: XCTestCase {
    private static let pinURL = URL(string: "https://github.com/Everaldtah/termforge/releases/download/rootfs-alpine-x86/alpine-x86.tar.gz")!
    private static let pinSHA = "9eedac4d3c1212c8c083800cbc9d9359841907cabe878d4839c8af847372ba72"

    private func metric(_ name: String, _ ms: Double) {
        print(String(format: "METRIC %@ %.0f ms", name, ms))
    }

    private var roots: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TermForge/test-roots", isDirectory: true)
    }

    private func installedRoot() async throws -> URL {
        let fakefs = roots.appendingPathComponent("alpine-x86", isDirectory: true)
        let marker = fakefs.appendingPathComponent(".termforge-installed")
        if (try? String(contentsOf: marker, encoding: .utf8)) == Self.pinSHA { return fakefs }
        try FileManager.default.createDirectory(at: roots, withIntermediateDirectories: true)
        let t0 = CACurrentMediaTime()
        let (tmp, response) = try await URLSession.shared.download(from: Self.pinURL)
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
        try Self.pinSHA.write(to: marker, atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: tar)
        return fakefs
    }

    func testBootShellAndExec() async throws {
        let runtime = LinuxRuntime.shared
        let fakefs = try await installedRoot()
        let host = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try FileManager.default.createDirectory(at: host, withIntermediateDirectories: true)
        try "from the host\n".write(to: host.appendingPathComponent("hello.txt"), atomically: true, encoding: .utf8)

        if !runtime.booted {
            let t0 = CACurrentMediaTime()
            try runtime.boot(fakefsDir: fakefs, hostDir: host, temporaryDir: FileManager.default.temporaryDirectory)
            metric("linux.boot", (CACurrentMediaTime() - t0) * 1000)
        }
        print("LINUX| \(runtime.version)")

        // a pty session: bash, python3, git, rg, the host mount
        let env = ["PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "TERM": "xterm-256color"]
        let script = "echo bash=$BASH_VERSION; python3 -c 'print(\"py\", 1+1)'; git --version; rg --version | head -1; cat /mnt/termforge/hello.txt; exit 3"
        let t1 = CACurrentMediaTime()
        let session = try runtime.startSession(argv: ["/bin/bash", "-c", script], env: env, cwd: "/root", cols: 80, rows: 24)
        var output = Data()
        let done = expectation(description: "session exit")
        var exitCode: Int32 = -1
        session.onOutput = { output.append($0) }
        session.onExit = { code in
            exitCode = code
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 120)
        metric("linux.session.bashPythonGitRg", (CACurrentMediaTime() - t1) * 1000)
        let text = String(decoding: output, as: UTF8.self)
        for line in text.split(separator: "\n") { print("LINUX| \(line)") }
        XCTAssertEqual(exitCode, 3)
        XCTAssertTrue(text.contains("bash=5."), text)
        XCTAssertTrue(text.contains("py 2"), text)
        XCTAssertTrue(text.contains("git version"), text)
        XCTAssertTrue(text.contains("ripgrep"), text)
        XCTAssertTrue(text.contains("from the host"), text)

        // exec with pipes: git init + commit in the shared folder, stdout/stderr apart
        let project = host.appendingPathComponent("exec-project", isDirectory: true)
        try? FileManager.default.removeItem(at: project)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let t2 = CACurrentMediaTime()
        var out = Data(), err = Data()
        let exited = expectation(description: "exec exit")
        var code: Int32 = -1
        let exec = try runtime.exec(argv: ["/bin/sh", "-c", "git init -q && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m first && git log --oneline && echo warn >&2"],
                                    env: env, cwd: "/mnt/termforge/exec-project",
                                    stdout: { out.append($0) }, stderr: { err.append($0) },
                                    completion: { c in code = c; exited.fulfill() })
        exec.closeStdin()
        await fulfillment(of: [exited], timeout: 120)
        metric("linux.exec.gitInitCommit", (CACurrentMediaTime() - t2) * 1000)
        XCTAssertEqual(code, 0, String(decoding: err, as: UTF8.self))
        XCTAssertTrue(String(decoding: out, as: UTF8.self).contains("first"))
        XCTAssertEqual(String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines), "warn")
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent(".git/HEAD").path), "the commit landed in the host folder")
    }
}
