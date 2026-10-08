import Foundation

/// Wire format shared with nodejs-project/lib/frame.js.
/// Every frame: u32 BE payload length | u8 type | u32 BE channel | payload.
/// Channel 0 is the control channel; sessions use channels >= 1.
public enum FrameType: UInt8, Sendable {
    case hello = 0x01
    case open = 0x02
    case data = 0x03
    case resize = 0x04
    case signal = 0x05
    case close = 0x06
    case exit = 0x07
    case request = 0x08
    case response = 0x09
    case event = 0x0a
    case log = 0x0b
}

public struct Frame: Equatable, Sendable {
    public static let headerSize = 9
    public static let maxPayload = 64 * 1024 * 1024

    public var type: FrameType
    public var channel: UInt32
    public var payload: [UInt8]

    public init(type: FrameType, channel: UInt32, payload: [UInt8] = []) {
        self.type = type
        self.channel = channel
        self.payload = payload
    }

    public init<T: Encodable>(type: FrameType, channel: UInt32, json: T) throws {
        self.init(type: type, channel: channel, payload: Array(try JSONEncoder().encode(json)))
    }

    public func encoded() -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(Frame.headerSize + payload.count)
        let len = UInt32(payload.count)
        out.append(contentsOf: [UInt8(len >> 24), UInt8((len >> 16) & 0xff), UInt8((len >> 8) & 0xff), UInt8(len & 0xff)])
        out.append(type.rawValue)
        out.append(contentsOf: [UInt8(channel >> 24), UInt8((channel >> 16) & 0xff), UInt8((channel >> 8) & 0xff), UInt8(channel & 0xff)])
        out.append(contentsOf: payload)
        return out
    }

    public func decodeJSON<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(payload))
    }

    public static func resize(channel: UInt32, cols: Int, rows: Int) -> Frame {
        let c = UInt16(clamping: cols), r = UInt16(clamping: rows)
        return Frame(type: .resize, channel: channel, payload: [UInt8(c >> 8), UInt8(c & 0xff), UInt8(r >> 8), UInt8(r & 0xff)])
    }
}

public enum FrameError: Error, Equatable {
    case payloadTooLarge(Int)
    case unknownType(UInt8)
}

/// Incremental decoder: push arbitrary byte chunks, receive complete frames.
public struct FrameDecoder {
    private var buffer: [UInt8] = []
    private var start = 0

    public init() {}

    public mutating func push<C: Collection>(_ bytes: C) throws -> [Frame] where C.Element == UInt8 {
        buffer.append(contentsOf: bytes)
        var frames: [Frame] = []
        while buffer.count - start >= Frame.headerSize {
            let len = Int(be32(at: start))
            guard len <= Frame.maxPayload else { throw FrameError.payloadTooLarge(len) }
            guard buffer.count - start >= Frame.headerSize + len else { break }
            let rawType = buffer[start + 4]
            guard let type = FrameType(rawValue: rawType) else { throw FrameError.unknownType(rawType) }
            let channel = be32(at: start + 5)
            let bodyStart = start + Frame.headerSize
            frames.append(Frame(type: type, channel: channel, payload: Array(buffer[bodyStart..<bodyStart + len])))
            start = bodyStart + len
        }
        // compact once the consumed prefix dominates, so the buffer does not grow without bound
        if start > 0 && (start == buffer.count || start > 64 * 1024) {
            buffer.removeFirst(start)
            start = 0
        }
        return frames
    }

    private func be32(at i: Int) -> UInt32 {
        UInt32(buffer[i]) << 24 | UInt32(buffer[i + 1]) << 16 | UInt32(buffer[i + 2]) << 8 | UInt32(buffer[i + 3])
    }
}
