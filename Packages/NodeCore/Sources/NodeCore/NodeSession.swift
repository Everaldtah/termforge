import Foundation
import QuartzCore

/// One terminal session (a worker thread in Node). Output that arrives before a terminal
/// view attaches is buffered, so nothing is lost while SwiftUI builds the view.
@MainActor
public final class NodeSession {
    public let channel: UInt32
    public let spec: SessionSpec
    public let openedAt = CACurrentMediaTime()
    public private(set) var firstOutputAt: CFTimeInterval?
    public private(set) var exit: SessionExit?
    /// Timings reported by Node (session.online, session.workerReady, session.entryLoaded, ...).
    public private(set) var metrics: [String: Double] = [:]

    public var onData: ((ArraySlice<UInt8>) -> Void)? {
        didSet { flushBacklog() }
    }
    public var onExit: ((SessionExit) -> Void)? {
        didSet { if let exit { onExit?(exit) } }
    }
    public var onEvent: ((NodeEvent) -> Void)?

    private weak var runtime: NodeRuntime?
    private var backlog: [UInt8] = []

    init(channel: UInt32, spec: SessionSpec, runtime: NodeRuntime) {
        self.channel = channel
        self.spec = spec
        self.runtime = runtime
    }

    public var isRunning: Bool { exit == nil }

    /// Milliseconds from open to the first byte of output.
    public var firstOutputMs: Double? {
        firstOutputAt.map { ($0 - openedAt) * 1000 }
    }

    public func write(_ bytes: [UInt8]) {
        guard isRunning, !bytes.isEmpty else { return }
        runtime?.send(Frame(type: .data, channel: channel, payload: bytes))
    }

    public func write(_ text: String) {
        write(Array(text.utf8))
    }

    public func resize(cols: Int, rows: Int) {
        guard isRunning, cols > 0, rows > 0 else { return }
        runtime?.send(.resize(channel: channel, cols: cols, rows: rows))
    }

    /// Deliver a signal (2 = SIGINT, 15 = SIGTERM, 1 = SIGHUP) to the program.
    public func signal(_ signo: UInt8) {
        guard isRunning else { return }
        runtime?.send(Frame(type: .signal, channel: channel, payload: [signo]))
    }

    /// Terminate the session's worker.
    public func close() {
        guard isRunning else { return }
        runtime?.send(Frame(type: .close, channel: channel))
    }

    func deliver(_ frame: Frame) {
        switch frame.type {
        case .data:
            if firstOutputAt == nil { firstOutputAt = CACurrentMediaTime() }
            if let onData { onData(frame.payload[...]) } else { backlog.append(contentsOf: frame.payload) }
        case .exit:
            deliverExit((try? frame.decodeJSON(SessionExit.self)) ?? SessionExit(code: nil, error: "unreadable exit frame"))
        case .event:
            guard let event = try? frame.decodeJSON(NodeEvent.self) else { return }
            if event.event == "metric", let name = event.name, let ms = event.ms { metrics[name] = ms }
            onEvent?(event)
        default:
            break
        }
    }

    func deliverExit(_ info: SessionExit) {
        guard exit == nil else { return }
        exit = info
        runtime?.forget(self)
        onExit?(info)
    }

    private func flushBacklog() {
        guard let onData, !backlog.isEmpty else { return }
        let pending = backlog
        backlog.removeAll()
        onData(pending[...])
    }
}
