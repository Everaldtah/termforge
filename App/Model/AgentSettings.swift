import Foundation

/// Defaults for new Agent tabs (the tab's /model and /effort commands change one tab only).
/// Mirrors the model table in nodejs-project/agent/loop.js.
enum AgentSettings {
    static let modelKey = "agent.model"
    static let effortKey = "agent.effort"
    static let defaultModel = "claude-opus-5-5"
    static let defaultEffort = "high"

    /// (model id, label) — the Messages API serves every one of these to an API key today.
    static let models: [(id: String, label: String)] = [
        ("claude-opus-5-5", "Claude Opus 5.5"),
        ("claude-fable-5-1", "Claude Fable 5.1"),
        ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
        ("claude-haiku-5-5", "Claude Haiku 5.5"),
        ("claude-opus-5", "Claude Opus 5"),
        ("claude-sonnet-5", "Claude Sonnet 5"),
    ]
    static let efforts = ["low", "medium", "high", "xhigh", "max"]

    static var model: String {
        UserDefaults.standard.string(forKey: modelKey) ?? defaultModel
    }

    static var effort: String {
        UserDefaults.standard.string(forKey: effortKey) ?? defaultEffort
    }
}
