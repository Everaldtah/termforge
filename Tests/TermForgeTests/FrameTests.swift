import NodeCore
import XCTest

final class FrameTests: XCTestCase {
    /// Bytes produced by nodejs-project/lib/frame.js: encode(T.DATA, 7, Buffer.from([0, 1, 2, 255])).
    private let jsDataFrame: [UInt8] = [0, 0, 0, 4, 0x03, 0, 0, 0, 7, 0, 1, 2, 255]

    func testEncodingMatchesTheJavaScriptSide() {
        XCTAssertEqual(Frame(type: .data, channel: 7, payload: [0, 1, 2, 255]).encoded(), jsDataFrame)
        XCTAssertEqual(Frame.resize(channel: 7, cols: 120, rows: 40).encoded(), [0, 0, 0, 4, 0x04, 0, 0, 0, 7, 0, 120, 0, 40])
    }

    func testDecoderSurvivesEveryFragmentation() throws {
        let wire = Frame(type: .hello, channel: 0, payload: Array(#"{"node":"v18"}"#.utf8)).encoded()
            + jsDataFrame
            + Frame(type: .close, channel: 9).encoded()
        for step in [1, 2, 3, 5, 8, 13, wire.count] {
            var decoder = FrameDecoder()
            var frames: [Frame] = []
            var i = 0
            while i < wire.count {
                frames += try decoder.push(wire[i..<min(i + step, wire.count)])
                i += step
            }
            XCTAssertEqual(frames.map(\.type), [.hello, .data, .close], "step \(step)")
            XCTAssertEqual(frames[1].channel, 7)
            XCTAssertEqual(frames[1].payload, [0, 1, 2, 255])
            XCTAssertEqual(frames[2].payload, [])
        }
    }

    func testDecoderRejectsOversizedAndUnknownFrames() {
        var decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push([0xff, 0xff, 0xff, 0xff, 0x03, 0, 0, 0, 1]))
        var decoder2 = FrameDecoder()
        XCTAssertThrowsError(try decoder2.push([0, 0, 0, 0, 0x7f, 0, 0, 0, 1]))
    }

    func testJSONPayloadRoundTrip() throws {
        let spec = SessionSpec(kind: .claude, cols: 100, rows: 30, cwd: "/tmp/p", env: ["A": "b"], argv: ["--continue"], platform: "linux")
        let frame = try Frame(type: .open, channel: 3, json: spec)
        var decoder = FrameDecoder()
        let decoded = try decoder.push(frame.encoded())
        XCTAssertEqual(try decoded.first?.decodeJSON(SessionSpec.self), spec)
    }
}
