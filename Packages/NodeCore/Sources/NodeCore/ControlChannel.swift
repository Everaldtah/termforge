import Foundation

/// One AF_UNIX socketpair between Swift and Node. Node receives its end as `--control-fd=N`
/// and wraps it in a net.Socket; no filesystem path or TCP port is involved.
final class ControlChannel {
    let swiftFD: Int32
    let nodeFD: Int32

    /// Called on the reader thread with every batch of decoded frames.
    var onFrames: (@Sendable ([Frame]) -> Void)?
    /// Called once on the reader thread when the socket closes or fails.
    var onClosed: (@Sendable (String?) -> Void)?

    private let writeQueue = DispatchQueue(label: "termforge.node.control.write", qos: .userInteractive)
    private var reader: Thread?

    init() throws {
        var fds: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        for fd in fds {
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var size: Int32 = 1 << 20
            setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
        }
        swiftFD = fds[0]
        nodeFD = fds[1]
    }

    func startReading() {
        let fd = swiftFD
        let thread = Thread { [weak self] in
            var decoder = FrameDecoder()
            let capacity = 64 * 1024
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
            defer { buffer.deallocate() }
            var failure: String?
            while true {
                let n = read(fd, buffer, capacity)
                if n > 0 {
                    do {
                        let frames = try decoder.push(UnsafeBufferPointer(start: buffer, count: n))
                        if !frames.isEmpty { self?.onFrames?(frames) }
                    } catch {
                        failure = "control protocol error: \(error)"
                        break
                    }
                } else if n == 0 {
                    break
                } else if errno != EINTR {
                    failure = String(cString: strerror(errno))
                    break
                }
            }
            self?.onClosed?(failure)
        }
        thread.name = "termforge.node.control.read"
        thread.qualityOfService = .userInteractive
        reader = thread
        thread.start()
    }

    func send(_ frame: Frame) {
        let bytes = frame.encoded()
        let fd = swiftFD
        writeQueue.async {
            bytes.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if n > 0 {
                        offset += n
                    } else if n < 0 && errno == EINTR {
                        continue
                    } else {
                        return
                    }
                }
            }
        }
    }
}
