import Foundation

/// Pairing with the PC bridge (tools/pc-bridge): address + name in UserDefaults, token in the
/// Keychain. A `termforge://pair?url=&token=&name=` link fills all three.
enum PCBridgeSettings {
    static let urlKey = "pc.url"
    static let nameKey = "pc.name"
    static let cwdKey = "pc.cwd"
    static let tokenAccount = "PC_BRIDGE_TOKEN"

    static var url: String? { UserDefaults.standard.string(forKey: urlKey) }
    static var name: String? { UserDefaults.standard.string(forKey: nameKey) }
    static var cwd: String? {
        let v = UserDefaults.standard.string(forKey: cwdKey)?.trimmingCharacters(in: .whitespaces)
        return v?.isEmpty == false ? v : nil
    }
    static var token: String? { Keychain.get(tokenAccount) }
    static var isPaired: Bool { url != nil && token != nil }

    static func pair(url: String, token: String, name: String?) {
        UserDefaults.standard.set(url.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey)
        UserDefaults.standard.set(name, forKey: nameKey)
        Keychain.set(token.trimmingCharacters(in: .whitespacesAndNewlines), for: tokenAccount)
    }

    static func unpair() {
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: nameKey)
        Keychain.delete(tokenAccount)
    }

    /// termforge://pair?url=ws://host:7788&token=…&name=PC
    static func parse(pairLink: URL) -> (url: String, token: String, name: String?)? {
        guard pairLink.scheme?.lowercased() == "termforge", pairLink.host?.lowercased() == "pair",
              let items = URLComponents(url: pairLink, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func item(_ n: String) -> String? { items.first { $0.name == n }?.value }
        guard let url = item("url"), let token = item("token"), !url.isEmpty, !token.isEmpty else { return nil }
        return (url, token, item("name"))
    }
}

/// One PTY on the PC over the bridge's WebSocket: binary frames are terminal bytes, text
/// frames are JSON control messages. Callbacks arrive on a background queue.
final class PCSession: NSObject, URLSessionWebSocketDelegate {
    var onData: ((Data) -> Void)?
    var onHello: (([String: Any]) -> Void)?
    /// (exit code, error) — the code comes from the bridge's exit message, the error from the transport.
    var onExit: ((Int?, String?) -> Void)?

    private let request: URLRequest
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var finished = false
    private let lock = NSLock()

    init(baseURL: String, token: String, cmd: String, cwd: String?, cols: Int, rows: Int, continueSession: Bool) throws {
        guard var comps = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = comps.scheme?.lowercased(), ["ws", "wss", "http", "https"].contains(scheme), comps.host != nil else {
            throw PCBridgeError.badAddress(baseURL)
        }
        comps.scheme = scheme == "https" ? "wss" : scheme == "http" ? "ws" : scheme
        comps.path = "/pty"
        var items = [URLQueryItem(name: "cmd", value: cmd), URLQueryItem(name: "cols", value: String(cols)), URLQueryItem(name: "rows", value: String(rows))]
        if let cwd { items.append(URLQueryItem(name: "cwd", value: cwd)) }
        if continueSession { items.append(URLQueryItem(name: "continue", value: "1")) }
        comps.queryItems = items
        guard let url = comps.url else { throw PCBridgeError.badAddress(baseURL) }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request = req
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func connect() {
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receive()
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 20, repeating: 20)
        timer.setEventHandler { [weak self] in self?.task?.sendPing { _ in } }
        timer.resume()
        pingTimer = timer
    }

    func write(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    func resize(cols: Int, rows: Int) {
        task?.send(.string("{\"t\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}")) { _ in }
    }

    func close() {
        finish(code: nil, error: nil, notify: false)
        task?.cancel(with: .normalClosure, reason: nil)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.data(let data)):
                self.onData?(data)
                self.receive()
            case .success(.string(let text)):
                self.control(text)
                self.receive()
            case .success:
                self.receive()
            case .failure(let error):
                self.finish(code: nil, error: error.localizedDescription, notify: true)
            }
        }
    }

    private func control(_ text: String) {
        guard let data = text.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["t"] as? String else { return }
        switch t {
        case "hello": onHello?(obj)
        case "exit": finish(code: obj["code"] as? Int, error: obj["error"] as? String, notify: true)
        default: break
        }
    }

    private func finish(code: Int?, error: String?, notify: Bool) {
        lock.lock()
        let first = !finished
        finished = true
        lock.unlock()
        guard first else { return }
        pingTimer?.cancel()
        pingTimer = nil
        if notify { onExit?(code, error) }
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(code: nil, error: closeCode == .normalClosure ? nil : "connection closed (\(closeCode.rawValue))", notify: true)
    }
}

enum PCBridgeError: LocalizedError {
    case notPaired
    case badAddress(String)

    var errorDescription: String? {
        switch self {
        case .notPaired: return "no PC bridge paired"
        case .badAddress(let s): return "bad bridge address: \(s)"
        }
    }
}
