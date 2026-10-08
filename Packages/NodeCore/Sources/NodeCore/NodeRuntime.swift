import Foundation
import NodeMobile
import QuartzCore

/// The single Node.js instance of the app process (nodejs-mobile can start Node once per
/// process). Node runs nodejs-project/main.js on its own thread; every terminal session is a
/// worker thread inside it, reached over one socketpair.
@MainActor
public final class NodeRuntime {
    public static let shared = NodeRuntime()

    public enum State: Equatable {
        case idle
        case starting
        case ready(NodeHello)
        case stopped(String)
    }

    public struct Configuration {
        /// The bundled nodejs-project directory (contains main.js).
        public var projectDirectory: URL
        /// Where packages (Claude Code) are installed: Application Support/TermForge.
        public var dataDirectory: URL
        /// $HOME for Node and every session: the shared, user-visible filesystem.
        public var homeDirectory: URL
        public var temporaryDirectory: URL
        /// Lets install requests carry their own pin (SIDELOAD builds only).
        public var allowPinOverride: Bool

        public init(projectDirectory: URL, dataDirectory: URL, homeDirectory: URL, temporaryDirectory: URL,
                    allowPinOverride: Bool = false) {
            self.projectDirectory = projectDirectory
            self.dataDirectory = dataDirectory
            self.homeDirectory = homeDirectory
            self.temporaryDirectory = temporaryDirectory
            self.allowPinOverride = allowPinOverride
        }
    }

    /// Wall-clock milestones of the runtime's start, from CACurrentMediaTime().
    public struct Timings: Equatable {
        public var startRequested: CFTimeInterval?
        public var helloReceived: CFTimeInterval?

        public var startupMs: Double? {
            guard let a = startRequested, let b = helloReceived else { return nil }
            return (b - a) * 1000
        }
    }

    public private(set) var state: State = .idle {
        didSet { for observer in stateObservers.values { observer(state) } }
    }
    public private(set) var timings = Timings()
    public var onLog: ((String) -> Void)?
    /// Channel-0 events such as install progress.
    public var onEvent: ((NodeEvent) -> Void)?

    private var channel: ControlChannel?
    private var sessions: [UInt32: NodeSession] = [:]
    private var nextChannel: UInt32 = 1
    private var nextRequestID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var readyWaiters: [CheckedContinuation<NodeHello, Error>] = []
    private var stateObservers: [UUID: (State) -> Void] = [:]

    public init() {}

    @discardableResult
    public func observeState(_ observer: @escaping (State) -> Void) -> UUID {
        let id = UUID()
        stateObservers[id] = observer
        observer(state)
        return id
    }

    public func removeObserver(_ id: UUID) {
        stateObservers[id] = nil
    }

    public func start(_ config: Configuration) {
        guard state == .idle else { return }
        state = .starting
        timings.startRequested = CACurrentMediaTime()

        let fm = FileManager.default
        for dir in [config.dataDirectory, config.homeDirectory, config.temporaryDirectory] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        // os.homedir()/os.tmpdir() read the process environment, which worker threads share.
        setenv("HOME", config.homeDirectory.path, 1)
        setenv("TMPDIR", config.temporaryDirectory.path, 1)

        let channel: ControlChannel
        do {
            channel = try ControlChannel()
        } catch {
            state = .stopped("socketpair failed: \(error)")
            return
        }
        self.channel = channel
        channel.onFrames = { [weak self] frames in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.handle(frames) } }
        }
        channel.onClosed = { [weak self] why in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.stop(why ?? "control socket closed") } }
        }
        channel.startReading()

        var args = [
            "node",
            "--jitless",
            config.projectDirectory.appendingPathComponent("main.js").path,
            "--control-fd=\(channel.nodeFD)",
            "--data-dir=\(config.dataDirectory.path)",
        ]
        if config.allowPinOverride { args.append("--allow-pin-override") }

        let thread = Thread {
            let code = NodeRuntime.startNode(args)
            DispatchQueue.main.async { MainActor.assumeIsolated { NodeRuntime.shared.stop("node exited with code \(code)") } }
        }
        thread.name = "nodejs"
        thread.stackSize = 4 << 20
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    /// node_start() needs all argv strings in one contiguous allocation (libuv rewrites
    /// it for the process title). The memory is intentionally never freed.
    nonisolated private static func startNode(_ args: [String]) -> Int32 {
        let cStrings = args.map { Array($0.utf8CString) }
        let total = cStrings.reduce(0) { $0 + $1.count }
        let block = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        let argv = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: args.count + 1)
        var offset = 0
        for (i, s) in cStrings.enumerated() {
            s.withUnsafeBufferPointer { (block + offset).initialize(from: $0.baseAddress!, count: s.count) }
            argv[i] = block + offset
            offset += s.count
        }
        argv[args.count] = nil
        return node_start(Int32(args.count), argv)
    }

    public func waitUntilReady() async throws -> NodeHello {
        switch state {
        case .ready(let hello): return hello
        case .stopped(let why): throw NodeRuntimeError.runtimeStopped(why)
        case .idle: throw NodeRuntimeError.notReady
        case .starting:
            return try await withCheckedThrowingContinuation { readyWaiters.append($0) }
        }
    }

    // MARK: sessions

    public func openSession(_ spec: SessionSpec) throws -> NodeSession {
        guard let channel else { throw NodeRuntimeError.notReady }
        let id = nextChannel
        nextChannel += 1
        let session = NodeSession(channel: id, spec: spec, runtime: self)
        sessions[id] = session
        channel.send(try Frame(type: .open, channel: id, json: spec))
        return session
    }

    func send(_ frame: Frame) {
        channel?.send(frame)
    }

    func forget(_ session: NodeSession) {
        sessions[session.channel] = nil
    }

    // MARK: requests

    public func request<R: Decodable>(_ op: String, _ params: [String: Any] = [:], as: R.Type) async throws -> R {
        guard let channel, case .ready = state else { throw NodeRuntimeError.notReady }
        let id = nextRequestID
        nextRequestID += 1
        var body = params
        body["id"] = id
        body["op"] = op
        let payload = Array(try JSONSerialization.data(withJSONObject: body))
        let data: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            channel.send(Frame(type: .request, channel: 0, payload: payload))
        }
        return try JSONDecoder().decode(R.self, from: data)
    }

    public func status() async throws -> RuntimeStatus {
        try await request("status", as: RuntimeStatus.self)
    }

    public func install(package: String, pin: PackagePin? = nil) async throws -> InstallResult {
        var params: [String: Any] = ["package": package]
        if let pin {
            params["pin"] = ["name": pin.name, "version": pin.version, "tarball": pin.tarball, "integrity": pin.integrity]
        }
        return try await request("install", params, as: InstallResult.self)
    }

    /// Round trip Swift -> Node -> Swift over the control channel, in milliseconds.
    public func ping() async throws -> Double {
        let t0 = CACurrentMediaTime()
        _ = try await request("ping", ["t": t0], as: PingResult.self)
        return (CACurrentMediaTime() - t0) * 1000
    }

    // MARK: frames

    private func handle(_ frames: [Frame]) {
        for frame in frames {
            switch frame.type {
            case .hello:
                guard let hello = try? frame.decodeJSON(NodeHello.self) else { continue }
                timings.helloReceived = CACurrentMediaTime()
                state = .ready(hello)
                let waiters = readyWaiters
                readyWaiters.removeAll()
                waiters.forEach { $0.resume(returning: hello) }
            case .response:
                handleResponse(frame.payload)
            case .log:
                onLog?(String(decoding: frame.payload, as: UTF8.self))
            case .event where frame.channel == 0:
                if let event = try? frame.decodeJSON(NodeEvent.self) { onEvent?(event) }
            case .data, .exit, .event:
                sessions[frame.channel]?.deliver(frame)
            case .request:
                handleNodeRequest(frame.payload)
            case .execIn:
                execInput(channel: frame.channel, bytes: frame.payload)
            case .open, .resize, .signal, .close, .execOut, .execExit:
                continue
            }
        }
    }

    private func handleResponse(_ payload: [UInt8]) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
              let id = obj["id"] as? Int, let cont = pending.removeValue(forKey: id) else { return }
        if obj["ok"] as? Bool == true {
            let result = obj["result"] ?? NSNull()
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]) {
                cont.resume(returning: data)
            } else {
                cont.resume(throwing: NodeRuntimeError.badResponse)
            }
        } else {
            cont.resume(throwing: NodeRuntimeError.requestFailed(obj["error"] as? String ?? "request failed"))
        }
    }

    // MARK: exec (Node's child_process -> the Linux layer)

    /// The app sets this once the Linux layer has booted; nil means every command fails with ENOENT.
    public var execBackend: ExecBackend? {
        didSet { send(Frame(type: .event, channel: 0, payload: Array(#"{"event":"linux","available":\#(execBackend != nil)}"#.utf8))) }
    }

    private var execs: [UInt32: ExecRelay] = [:]

    /// Collects output for one exec and streams it to Node as frames.
    private final class ExecRelay: ExecOutput, @unchecked Sendable {
        let channel: UInt32
        weak var runtime: NodeRuntime?
        var handle: Int32 = -1

        init(channel: UInt32, runtime: NodeRuntime) {
            self.channel = channel
            self.runtime = runtime
        }

        func stdout(_ data: Data) { emit(fd: 1, data) }
        func stderr(_ data: Data) { emit(fd: 2, data) }

        private func emit(fd: UInt8, _ data: Data) {
            runtime?.sendFromAnyThread(Frame(type: .execOut, channel: channel, payload: [fd] + Array(data)))
        }

        func exited(code: Int32, signal: String?) {
            var body: [String: Any] = ["code": Int(code)]
            if let signal { body["signal"] = signal }
            let payload = (try? JSONSerialization.data(withJSONObject: body)).map(Array.init) ?? Array(#"{"code":1}"#.utf8)
            runtime?.sendFromAnyThread(Frame(type: .execExit, channel: channel, payload: payload))
            let channel = self.channel
            DispatchQueue.main.async { MainActor.assumeIsolated { self.runtime?.execs[channel] = nil } }
        }
    }

    nonisolated func sendFromAnyThread(_ frame: Frame) {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.send(frame) } }
    }

    private func handleNodeRequest(_ payload: [UInt8]) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
              let id = obj["id"] as? Int, let op = obj["op"] as? String else { return }
        func respond(_ result: [String: Any]?, error: String? = nil) {
            var body: [String: Any] = ["id": id, "ok": error == nil]
            if let result { body["result"] = result }
            if let error { body["error"] = error }
            if let data = try? JSONSerialization.data(withJSONObject: body) { send(Frame(type: .response, channel: 0, payload: Array(data))) }
        }
        switch op {
        case "exec":
            guard let backend = execBackend else { return respond(nil, error: "the Linux layer is not running") }
            guard let channel = (obj["channel"] as? NSNumber)?.uint32Value, let argv = obj["argv"] as? [String], !argv.isEmpty else {
                return respond(nil, error: "bad exec request")
            }
            let request = ExecRequest(argv: argv, cwd: obj["cwd"] as? String ?? "/", env: obj["env"] as? [String: String] ?? [:])
            let relay = ExecRelay(channel: channel, runtime: self)
            do {
                let handle = try backend.start(request, output: relay)
                relay.handle = handle
                execs[channel] = relay
                respond(["pid": Int(handle)])
            } catch {
                respond(nil, error: error.localizedDescription)
            }
        case "exec-kill":
            if let channel = (obj["channel"] as? NSNumber)?.uint32Value, let relay = execs[channel] {
                execBackend?.kill(relay.handle, signal: Int32((obj["signal"] as? NSNumber)?.intValue ?? 15))
            }
            respond([:])
        default:
            respond(nil, error: "unknown op \(op)")
        }
    }

    private func execInput(channel: UInt32, bytes: [UInt8]) {
        guard let relay = execs[channel], let backend = execBackend else { return }
        if bytes.isEmpty { backend.closeStdin(relay.handle) } else { backend.writeStdin(relay.handle, Data(bytes)) }
    }

    private func stop(_ why: String) {
        if case .stopped = state { return }
        state = .stopped(why)
        let waiters = readyWaiters
        readyWaiters.removeAll()
        waiters.forEach { $0.resume(throwing: NodeRuntimeError.runtimeStopped(why)) }
        let requests = pending
        pending.removeAll()
        requests.values.forEach { $0.resume(throwing: NodeRuntimeError.runtimeStopped(why)) }
        for session in sessions.values {
            session.deliverExit(SessionExit(code: nil, error: why, reason: "RUNTIME_STOPPED", ms: nil))
        }
        sessions.removeAll()
    }
}
