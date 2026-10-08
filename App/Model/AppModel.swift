import Foundation
import NodeCore
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var sessions: [TerminalSession] = []
    @Published var selectedID: TerminalSession.ID?
    @Published private(set) var runtimeState: NodeRuntime.State = .idle
    @Published private(set) var claude: PackageStatus?
    @Published private(set) var installing = false
    @Published private(set) var installProgress: Double?
    @Published private(set) var installMessage: String?
    @Published private(set) var hasAPIKey = Keychain.get(Keychain.anthropicAPIKey) != nil
    @Published var showSettings = false

    let uiTestMode = ProcessInfo.processInfo.arguments.contains("-UITestMode")
    let runtime = NodeRuntime.shared
    private var restored = false
    private static let savedSessionsKey = "sessions.v1"

    #if SIDELOAD
    static let allowsCustomPins = true
    #else
    static let allowsCustomPins = false
    #endif

    var selected: TerminalSession? {
        sessions.first { $0.id == selectedID }
    }

    func start() {
        guard runtimeState == .idle, let project = Paths.nodeProject else {
            if Paths.nodeProject == nil { runtimeState = .stopped("nodejs-project is missing from the app bundle") }
            return
        }
        Paths.ensureProjects()
        runtime.onEvent = { [weak self] event in self?.handleRuntimeEvent(event) }
        runtime.observeState { [weak self] state in
            guard let self else { return }
            self.runtimeState = state
            if case .ready = state { Task { await self.runtimeReady() } }
        }
        runtime.start(.init(projectDirectory: project, dataDirectory: Paths.data, homeDirectory: Paths.home,
                            temporaryDirectory: Paths.temporary, allowPinOverride: Self.allowsCustomPins))
    }

    private func runtimeReady() async {
        await refreshStatus()
        guard !restored else { return }
        restored = true
        let saved = loadSavedSessions()
        if saved.isEmpty {
            // UI tests always start from a Node REPL tab, installed Claude Code or not
            let first: SessionKind = claude?.installed != nil && !uiTestMode ? .claude : .repl
            newSession(kind: first, project: Paths.defaultProject)
        } else {
            for item in saved {
                newSession(kind: item.kind, project: URL(fileURLWithPath: item.project), resume: item.kind == .claude)
            }
        }
    }

    func refreshStatus() async {
        guard let status = try? await runtime.status() else { return }
        claude = status.packages["claude-code"]
    }

    // MARK: sessions

    func newSession(kind: SessionKind, project: URL = Paths.defaultProject, resume: Bool = false) {
        let session = TerminalSession(kind: kind, project: project, resume: resume)
        if uiTestMode { session.startSnapshotting() }
        sessions.append(session)
        selectedID = session.id
        if kind != .claude || claude?.installed != nil {
            session.start(apiKey: apiKey)
        }
        saveSessions()
    }

    func close(_ session: TerminalSession) {
        session.close()
        sessions.removeAll { $0.id == session.id }
        if selectedID == session.id { selectedID = sessions.last?.id }
        saveSessions()
    }

    func restart(_ session: TerminalSession) {
        session.restart(apiKey: apiKey)
    }

    private var apiKey: String? {
        Keychain.get(Keychain.anthropicAPIKey)
    }

    // MARK: Claude Code install

    func installClaude(pin: PackagePin? = nil) {
        guard !installing else { return }
        installing = true
        installProgress = 0
        installMessage = "Downloading from registry.npmjs.org…"
        Task {
            defer { installing = false }
            do {
                let result = try await runtime.install(package: "claude-code", pin: pin)
                installProgress = nil
                installMessage = "Installed \(result.version) in \(Int(result.ms)) ms (\(result.written) files; \(result.skipped.count) desktop-only native files skipped)"
                await refreshStatus()
                for s in sessions where s.kind == .claude && !s.running { s.restart(apiKey: apiKey) }
            } catch {
                installProgress = nil
                installMessage = "Install failed: \(error.localizedDescription)"
            }
        }
    }

    private func handleRuntimeEvent(_ event: NodeEvent) {
        guard event.event == "install-progress" else { return }
        switch event.phase {
        case "download":
            if let got = event.got, let total = event.total, total > 0 { installProgress = got / total }
        case "verify":
            installMessage = "Verified SHA-512 integrity; unpacking…"
        default:
            break
        }
    }

    // MARK: API key

    func saveAPIKey(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Keychain.set(trimmed, for: Keychain.anthropicAPIKey)
        hasAPIKey = true
    }

    func deleteAPIKey() {
        Keychain.delete(Keychain.anthropicAPIKey)
        hasAPIKey = false
    }

    // MARK: lifecycle

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            saveSessions()
        case .active:
            if case .ready = runtimeState { Task { await refreshStatus() } }
        default:
            break
        }
    }

    private struct SavedSession: Codable {
        var kind: SessionKind
        var project: String
    }

    private func saveSessions() {
        let items = sessions.filter { $0.kind != .script }.map { SavedSession(kind: $0.kind, project: $0.project.path) }
        UserDefaults.standard.set(try? JSONEncoder().encode(items), forKey: Self.savedSessionsKey)
    }

    private func loadSavedSessions() -> [SavedSession] {
        if uiTestMode { return [] }
        guard let data = UserDefaults.standard.data(forKey: Self.savedSessionsKey),
              let items = try? JSONDecoder().decode([SavedSession].self, from: data) else { return [] }
        // the data container path can change across app updates; keep the project folder name
        return items.map { item in
            let name = URL(fileURLWithPath: item.project).lastPathComponent
            return SavedSession(kind: item.kind, project: Paths.projects.appendingPathComponent(name).path)
        }
    }
}
