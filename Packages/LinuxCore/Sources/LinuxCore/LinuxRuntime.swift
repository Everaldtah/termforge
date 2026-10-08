import Foundation
import iSHCore

public enum LinuxError: Error, LocalizedError, Equatable {
    case notBooted
    case alreadyBooted
    case kernel(Int32, String)
    case importFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notBooted: return "The Linux layer is not running."
        case .alreadyBooted: return "The Linux layer is already running."
        case .kernel(let errno, let what): return "\(what) failed (errno \(errno))."
        case .importFailed(let message): return "Root filesystem import failed: \(message)"
        }
    }
}

/// The iSH kernel: one instance per app process, booted once with a root filesystem.
/// Sessions (`LinuxSession`) are processes on their own pseudo-terminals; `exec` runs
/// a program with piped stdio for the Node child_process shim.
public final class LinuxRuntime: @unchecked Sendable {
    public static let shared = LinuxRuntime()

    /// Where the host filesystem (the app's Documents folder) appears inside every root.
    public static let hostMountPoint = "/mnt/termforge"

    private let lock = NSLock()
    private var sessions: [Int32: LinuxSession] = [:]
    private var execs: [Int32: (Int32) -> Void] = [:]
    private var pidToPty: [Int32: Int32] = [:]
    private(set) public var booted = false
    public var onLog: ((String) -> Void)?

    private init() {}

    public var version: String {
        String(cString: tf_ish_version())
    }

    /// Converts a rootfs tar.gz into a fakefs directory (long; run off the main thread).
    public func importRootfs(tarGz: URL, into fakefsDir: URL) throws {
        var err = [CChar](repeating: 0, count: 512)
        let rc = tf_ish_import_rootfs(tarGz.path, fakefsDir.path, &err, err.count)
        if rc != 0 { throw LinuxError.importFailed(String(cString: err)) }
    }

    public func boot(fakefsDir: URL, hostDir: URL, temporaryDir: URL) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !booted else { throw LinuxError.alreadyBooted }
        let unmanaged = Unmanaged.passUnretained(self).toOpaque()
        let callbacks = tf_ish_callbacks(
            output: { pty, buf, len, ctx in
                guard let ctx, let buf else { return }
                let runtime = Unmanaged<LinuxRuntime>.fromOpaque(ctx).takeUnretainedValue()
                runtime.deliverOutput(pty: pty, bytes: UnsafeRawBufferPointer(start: buf, count: len))
            },
            exited: { pid, code, ctx in
                guard let ctx else { return }
                let runtime = Unmanaged<LinuxRuntime>.fromOpaque(ctx).takeUnretainedValue()
                runtime.deliverExit(pid: pid, code: code)
            },
            log: { line, ctx in
                guard let ctx, let line else { return }
                let runtime = Unmanaged<LinuxRuntime>.fromOpaque(ctx).takeUnretainedValue()
                let text = String(cString: line)
                DispatchQueue.main.async { runtime.onLog?(text) }
            },
            ctx: unmanaged
        )
        let rc = tf_ish_boot(fakefsDir.path, hostDir.path, Self.hostMountPoint, temporaryDir.path, callbacks)
        guard rc == 0 else { throw LinuxError.kernel(-rc, "boot") }
        booted = true
    }

    // MARK: sessions

    public func startSession(argv: [String], env: [String: String], cwd: String?, cols: Int, rows: Int) throws -> LinuxSession {
        guard booted else { throw LinuxError.notBooted }
        var pty: Int32 = -1
        var pid: Int32 = -1
        let rc = withCStringArray(argv) { argvPtr in
            withCStringArray(env.map { "\($0.key)=\($0.value)" }) { envPtr in
                tf_ish_session_start(argvPtr, envPtr, cwd, Int32(cols), Int32(rows), &pty, &pid)
            }
        }
        guard rc == 0 else { throw LinuxError.kernel(-rc, "start \(argv.first ?? "")") }
        let session = LinuxSession(pty: pty, pid: pid, runtime: self)
        lock.lock()
        sessions[pty] = session
        pidToPty[pid] = pty
        lock.unlock()
        return session
    }

    /// Runs a program with piped stdio. `stdout`/`stderr` receive data as it arrives and
    /// `completion` the exit status, all on one serial queue, in order: nothing arrives
    /// after `completion`. Feed stdin through the returned handle; close it when done.
    public func exec(argv: [String], env: [String: String], cwd: String?,
                     stdout: @escaping (Data) -> Void, stderr: @escaping (Data) -> Void,
                     completion: @escaping (Int32) -> Void) throws -> LinuxExec {
        guard booted else { throw LinuxError.notBooted }
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        let pid = withCStringArray(argv) { argvPtr in
            withCStringArray(env.map { "\($0.key)=\($0.value)" }) { envPtr in
                tf_ish_exec(argvPtr, envPtr, cwd, inPipe.fileHandleForReading.fileDescriptor,
                            outPipe.fileHandleForWriting.fileDescriptor, errPipe.fileHandleForWriting.fileDescriptor)
            }
        }
        // the kernel holds its own copies now
        try? inPipe.fileHandleForReading.close()
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        guard pid > 0 else {
            try? inPipe.fileHandleForWriting.close()
            throw LinuxError.kernel(-pid, "exec \(argv.first ?? "")")
        }
        let exec = LinuxExec(pid: pid, stdin: inPipe, stdout: outPipe, stderr: errPipe, runtime: self,
                             onStdout: stdout, onStderr: stderr, onExit: completion)
        lock.lock()
        execs[pid] = { [exec] code in exec.finish(code: code) }
        lock.unlock()
        exec.startReading()
        return exec
    }

    public func kill(pid: Int32, signal: Int32) {
        _ = tf_ish_kill(pid, signal)
    }

    // MARK: callbacks (emulator threads)

    private func deliverOutput(pty: Int32, bytes: UnsafeRawBufferPointer) {
        lock.lock()
        let session = sessions[pty]
        lock.unlock()
        session?.receive(Data(bytes))
    }

    private func deliverExit(pid: Int32, code: Int32) {
        lock.lock()
        let completion = execs.removeValue(forKey: pid)
        let pty = pidToPty.removeValue(forKey: pid)
        let session = pty.flatMap { sessions[$0] }
        if let pty { sessions[pty] = nil }
        lock.unlock()
        if let completion { DispatchQueue.global().async { completion(code) } }
        session?.finished(code: code)
    }
}

/// A program started with `LinuxRuntime.exec`: its pid, the write end of its stdin, and
/// the readers that deliver stdout/stderr/exit in order on one serial queue.
public final class LinuxExec: @unchecked Sendable {
    public let pid: Int32
    private let stdinPipe: Pipe
    private let outPipe: Pipe
    private let errPipe: Pipe
    private weak var runtime: LinuxRuntime?
    private let onStdout: (Data) -> Void
    private let onStderr: (Data) -> Void
    private let onExit: (Int32) -> Void
    private let events = DispatchQueue(label: "termforge.linux.exec")
    private let lock = NSLock()
    private var stdinOpen = true
    private var finished = false

    init(pid: Int32, stdin: Pipe, stdout: Pipe, stderr: Pipe, runtime: LinuxRuntime,
         onStdout: @escaping (Data) -> Void, onStderr: @escaping (Data) -> Void, onExit: @escaping (Int32) -> Void) {
        self.pid = pid
        self.stdinPipe = stdin
        self.outPipe = stdout
        self.errPipe = stderr
        self.runtime = runtime
        self.onStdout = onStdout
        self.onStderr = onStderr
        self.onExit = onExit
    }

    func startReading() {
        for (pipe, deliver) in [(outPipe, onStdout), (errPipe, onStderr)] {
            pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
                guard let self else { return }
                // read and enqueue under the lock, so an exit that follows drains and
                // closes after this chunk is already queued
                self.lock.lock()
                defer { self.lock.unlock() }
                if self.finished { return }
                let d = h.availableData
                if d.isEmpty { h.readabilityHandler = nil } else { self.events.async { deliver(d) } }
            }
        }
    }

    /// Called by the runtime when the guest process exits (any thread).
    func finish(code: Int32) {
        lock.lock()
        finished = true
        for (pipe, deliver) in [(outPipe, onStdout), (errPipe, onStderr)] {
            let h = pipe.fileHandleForReading
            h.readabilityHandler = nil
            while let rest = try? h.read(upToCount: 1 << 16), !rest.isEmpty { events.async { deliver(rest) } }
            try? h.close()
        }
        lock.unlock()
        closeStdin()
        events.async { self.onExit(code) }
    }

    public func writeStdin(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard stdinOpen, !data.isEmpty else { return }
        try? stdinPipe.fileHandleForWriting.write(contentsOf: data)
    }

    public func closeStdin() {
        lock.lock(); defer { lock.unlock() }
        guard stdinOpen else { return }
        stdinOpen = false
        try? stdinPipe.fileHandleForWriting.close()
    }

    public func kill(signal: Int32 = 15) {
        runtime?.kill(pid: pid, signal: signal)
    }
}

/// A process on a pseudo-terminal inside the Linux layer.
public final class LinuxSession: @unchecked Sendable {
    public let pty: Int32
    public let pid: Int32
    private weak var runtime: LinuxRuntime?
    private let queue = DispatchQueue(label: "termforge.linux.session")
    private var backlog = Data()
    private var exitCode: Int32?

    /// Set once; delivered on `queue`. Output that arrived earlier is replayed first.
    public var onOutput: ((Data) -> Void)? {
        didSet { queue.async { self.flushBacklog() } }
    }
    public var onExit: ((Int32) -> Void)? {
        didSet { queue.async { if let code = self.exitCode { self.onExit?(code) } } }
    }

    init(pty: Int32, pid: Int32, runtime: LinuxRuntime) {
        self.pty = pty
        self.pid = pid
        self.runtime = runtime
    }

    public var isRunning: Bool { queue.sync { exitCode == nil } }

    public func write(_ data: Data) {
        data.withUnsafeBytes { raw in
            _ = tf_ish_session_input(pty, raw.baseAddress, raw.count)
        }
    }

    public func resize(cols: Int, rows: Int) {
        tf_ish_session_resize(pty, Int32(cols), Int32(rows))
    }

    public func hangup() {
        tf_ish_session_hangup(pty)
    }

    func receive(_ data: Data) {
        queue.async {
            if let onOutput = self.onOutput { onOutput(data) } else { self.backlog.append(data) }
        }
    }

    func finished(code: Int32) {
        queue.async {
            self.exitCode = code
            self.onExit?(code)
        }
    }

    private func flushBacklog() {
        guard let onOutput, !backlog.isEmpty else { return }
        let pending = backlog
        backlog.removeAll()
        onOutput(pending)
    }
}

/// Calls body with a NULL-terminated array of C strings.
func withCStringArray<R>(_ strings: [String], _ body: (UnsafePointer<UnsafePointer<CChar>?>) -> R) -> R {
    let cStrings = strings.map { strdup($0) }
    defer { cStrings.forEach { free($0) } }
    var pointers: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer($0) }
    pointers.append(nil)
    return pointers.withUnsafeBufferPointer { body($0.baseAddress!) }
}
