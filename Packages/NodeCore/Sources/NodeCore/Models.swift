import Foundation

/// What a terminal tab runs inside the shared Node runtime.
public enum SessionKind: String, Codable, Sendable, CaseIterable {
    /// Claude Code's cli.js (installed on-device from the npm registry).
    case claude
    /// A Node.js REPL.
    case repl
    /// Any JavaScript entry file.
    case script
}

/// Sent to Node in the OPEN frame.
public struct SessionSpec: Codable, Sendable, Equatable {
    public var kind: SessionKind
    public var cols: Int
    public var rows: Int
    public var cwd: String?
    public var env: [String: String]
    public var argv: [String]
    public var entry: String?
    /// `process.platform` as the session sees it. Claude Code sessions use "linux": their
    /// tools run in the Linux layer, and Claude Code then keeps credentials in ~/.claude.
    public var platform: String?

    public init(kind: SessionKind, cols: Int = 80, rows: Int = 24, cwd: String? = nil, env: [String: String] = [:],
                argv: [String] = [], entry: String? = nil, platform: String? = nil) {
        self.kind = kind
        self.cols = cols
        self.rows = rows
        self.cwd = cwd
        self.env = env
        self.argv = argv
        self.entry = entry
        self.platform = platform
    }
}

/// Node's HELLO frame.
public struct NodeHello: Codable, Sendable, Equatable {
    public var node: String
    public var v8: String
    public var platform: String
    public var arch: String
    public var jitless: Bool
    public var pid: Int
    public var supervisorMs: Double
    public var processUptimeMs: Double
}

/// Node's EXIT frame for a session.
public struct SessionExit: Codable, Sendable, Equatable {
    public var code: Int?
    public var error: String?
    public var reason: String?
    public var ms: Double?

    public init(code: Int? = nil, error: String? = nil, reason: String? = nil, ms: Double? = nil) {
        self.code = code
        self.error = error
        self.reason = reason
        self.ms = ms
    }

    public var notInstalled: Bool { reason == "NOT_INSTALLED" }
}

/// EVENT frames: exec records, URL hand-offs, timings and install progress.
public struct NodeEvent: Codable, Sendable, Equatable {
    public var event: String
    // open-url
    public var url: String?
    // metric
    public var name: String?
    public var ms: Double?
    // exec
    public var tier: String?
    public var file: String?
    public var args: [String]?
    public var code: Int?
    public var signal: String?
    // install-progress
    public var package: String?
    public var phase: String?
    public var got: Double?
    public var total: Double?
    public var dir: String?
}

public struct PackageStatus: Codable, Sendable, Equatable {
    public var pinned: String
    public var installed: String?
}

public struct RuntimeStatus: Codable, Sendable, Equatable {
    public var node: String
    public var v8: String
    public var platform: String
    public var arch: String
    public var jitless: Bool
    public var dataDir: String
    public var packages: [String: PackageStatus]
}

public struct InstallResult: Codable, Sendable, Equatable {
    public struct Skipped: Codable, Sendable, Equatable {
        public var path: String
        public var reason: String
        public var bytes: Int?
    }

    public var dir: String
    public var version: String
    public var ms: Double
    public var written: Int
    public var skipped: [Skipped]
}

/// A pin supplied at runtime (SIDELOAD builds only); App Store builds run only the pins
/// shipped inside the app bundle.
public struct PackagePin: Codable, Sendable, Equatable {
    public var name: String
    public var version: String
    public var tarball: String
    public var integrity: String

    public init(name: String, version: String, tarball: String, integrity: String) {
        self.name = name
        self.version = version
        self.tarball = tarball
        self.integrity = integrity
    }
}

public struct PingResult: Codable, Sendable, Equatable {
    public var now: Double
}

public enum NodeRuntimeError: Error, LocalizedError, Equatable {
    case notReady
    case requestFailed(String)
    case runtimeStopped(String)
    case badResponse

    public var errorDescription: String? {
        switch self {
        case .notReady: return "The Node runtime is not running."
        case .requestFailed(let message): return message
        case .runtimeStopped(let why): return "The Node runtime stopped: \(why)"
        case .badResponse: return "Malformed response from the Node runtime."
        }
    }
}
