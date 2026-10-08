import Foundation

/// Where everything lives inside the app sandbox.
enum Paths {
    /// The shared filesystem: $HOME for Node and every session, visible in the Files app.
    static var home: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var projects: URL {
        home.appendingPathComponent("Projects", isDirectory: true)
    }

    static var defaultProject: URL {
        projects.appendingPathComponent("Scratch", isDirectory: true)
    }

    /// Installed packages (Claude Code) and runtime state; not user-visible.
    static var data: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TermForge", isDirectory: true)
    }

    static var temporary: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    }

    static var nodeProject: URL? {
        Bundle.main.url(forResource: "nodejs-project", withExtension: nil)
    }

    static func ensureProjects() {
        try? FileManager.default.createDirectory(at: defaultProject, withIntermediateDirectories: true)
    }

    static func projectFolders() -> [URL] {
        ensureProjects()
        let items = (try? FileManager.default.contentsOfDirectory(at: projects, includingPropertiesForKeys: [.isDirectoryKey],
                                                                  options: [.skipsHiddenFiles])) ?? []
        return items
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    /// Claude Code keeps each project's transcripts in ~/.claude/projects/<cwd with every
    /// non-alphanumeric character replaced by "-">. A resume is only offered when one exists.
    static func hasClaudeConversation(cwd: URL) -> Bool {
        let slug = String(cwd.path.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        let dir = home.appendingPathComponent(".claude/projects/\(slug)", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return files.contains { $0.hasSuffix(".jsonl") }
    }
}
