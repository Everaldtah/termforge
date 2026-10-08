import CryptoKit
import Foundation
import LinuxCore
import NodeCore

/// The Linux layer as the app sees it: a pinned Alpine root downloaded from this project's
/// releases, converted to iSH's on-disk format, booted once, and offered to Node sessions
/// as their child_process backend.
@MainActor
final class LinuxLayer: ObservableObject {
    enum State: Equatable {
        case notInstalled
        case downloading(Double)
        case importing
        case booting
        case ready
        case failed(String)

        var isReady: Bool { self == .ready }
    }

    /// Built by scripts/build-rootfs.sh in .github/workflows/build-rootfs.yml.
    struct RootfsPin {
        let name = "alpine-x86"
        let url = URL(string: "https://github.com/Everaldtah/termforge/releases/download/rootfs-alpine-x86/alpine-x86.tar.gz")!
        let sha256 = "1ddbf9a4d2bab4f5cc58c2f50b4162a8a4dc0c5878a649062e28295bffce74ad"
    }

    @Published private(set) var state: State = .notInstalled
    @Published private(set) var bootMs: Double?
    @Published private(set) var importMs: Double?
    let pin = RootfsPin()
    let runtime = LinuxRuntime.shared

    private var rootsDir: URL { Paths.data.appendingPathComponent("roots", isDirectory: true) }
    private var tarball: URL { rootsDir.appendingPathComponent("\(pin.name).tar.gz") }
    var fakefsDir: URL { rootsDir.appendingPathComponent(pin.name, isDirectory: true) }
    private var installedMarker: URL { fakefsDir.appendingPathComponent(".termforge-installed") }

    var isInstalled: Bool {
        (try? String(contentsOf: installedMarker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) == pin.sha256
    }

    /// At launch: boot an installed root straight away.
    func startIfInstalled() {
        guard isInstalled, state == .notInstalled else { return }
        Task { await boot() }
    }

    /// Download + import + boot; progress is published through `state`.
    func install() {
        guard state == .notInstalled || { if case .failed = state { return true } else { return false } }() else { return }
        Task { await installAndBoot() }
    }

    private func installAndBoot() async {
        do {
            try FileManager.default.createDirectory(at: rootsDir, withIntermediateDirectories: true)
            if !isInstalled {
                state = .downloading(0)
                try await download()
                state = .importing
                let t0 = Date()
                try Self.removeIfPresent(fakefsDir)
                let (tar, dir, rt) = (tarball, fakefsDir, runtime)
                try await Task.detached(priority: .userInitiated) { try rt.importRootfs(tarGz: tar, into: dir) }.value
                importMs = Date().timeIntervalSince(t0) * 1000
                try pin.sha256.write(to: installedMarker, atomically: true, encoding: .utf8)
                try? FileManager.default.removeItem(at: tarball)
            }
            await boot()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func download() async throws {
        let (tmp, response) = try await URLSession.shared.download(from: pin.url, delegate: nil)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw LinuxLayerError.download("HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        state = .downloading(1)
        let digest = try Self.sha256(of: tmp)
        guard digest == pin.sha256 else {
            try? FileManager.default.removeItem(at: tmp)
            throw LinuxLayerError.download("SHA-256 mismatch: expected \(pin.sha256), got \(digest)")
        }
        try Self.removeIfPresent(tarball)
        try FileManager.default.moveItem(at: tmp, to: tarball)
    }

    private func boot() async {
        guard !runtime.booted else {
            state = .ready
            return
        }
        state = .booting
        let t0 = Date()
        do {
            try runtime.boot(fakefsDir: fakefsDir, hostDir: Paths.home, temporaryDir: Paths.temporary)
            bootMs = Date().timeIntervalSince(t0) * 1000
            NodeRuntime.shared.execBackend = LinuxExecBackend(runtime: runtime)
            state = .ready
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    nonisolated static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

enum LinuxLayerError: Error, LocalizedError {
    case download(String)

    var errorDescription: String? {
        switch self {
        case .download(let why): return "Root filesystem download failed: \(why)"
        }
    }
}

/// Node's child_process requests, run in the Linux layer.
final class LinuxExecBackend: ExecBackend {
    private let runtime: LinuxRuntime
    private var live: [Int32: LinuxExec] = [:]
    private let lock = NSLock()

    init(runtime: LinuxRuntime) {
        self.runtime = runtime
    }

    func start(_ request: ExecRequest, output: ExecOutput) throws -> Int32 {
        let exec = try runtime.exec(argv: request.argv, env: request.env, cwd: request.cwd,
                                    stdout: { output.stdout($0) }, stderr: { output.stderr($0) },
                                    completion: { [weak self] code in
                                        output.exited(code: code, signal: nil)
                                        self?.forget(code: code, pidHint: nil)
                                    })
        lock.lock()
        live[exec.pid] = exec
        lock.unlock()
        return exec.pid
    }

    private func forget(code: Int32, pidHint: Int32?) {
        // completion closures don't carry the pid; drop finished entries lazily on the next start
        lock.lock()
        defer { lock.unlock() }
        if live.count > 64 { live.removeAll() }
    }

    func writeStdin(_ handle: Int32, _ data: Data) {
        lock.lock(); let exec = live[handle]; lock.unlock()
        exec?.writeStdin(data)
    }

    func closeStdin(_ handle: Int32) {
        lock.lock(); let exec = live[handle]; lock.unlock()
        exec?.closeStdin()
    }

    func kill(_ handle: Int32, signal: Int32) {
        runtime.kill(pid: handle, signal: signal)
    }
}

extension LinuxLayer {
    /// `removeItem` on a missing path is not a failure here.
    nonisolated static func removeIfPresent(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
