import NodeCore
import SwiftUI
import TerminalUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            TabStrip()
            Divider()
            ZStack {
                Color(red: 0.07, green: 0.07, blue: 0.09).ignoresSafeArea(edges: .bottom)
                if let session = model.selected {
                    SessionView(session: session)
                        .id(session.id)
                } else {
                    RuntimeStatusView()
                }
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView()
        }
    }
}

/// Shown when no tab is open, or while Node is still starting.
struct RuntimeStatusView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            switch model.runtimeState {
            case .idle, .starting:
                ProgressView()
                Text("Starting Node…").foregroundStyle(.secondary)
            case .ready:
                Text("No open tabs").foregroundStyle(.secondary)
                Button("New Claude Code tab") { model.newSession(kind: .claude) }
            case .stopped(let why):
                Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                Text("The Node runtime stopped").font(.headline)
                Text(why).font(.footnote.monospaced()).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Text("Node can only start once per app launch; reopen TermForge to start it again.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
        .padding()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("runtime.status")
    }
}

struct SessionView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var session: TerminalSession

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottom) {
                TerminalHostView(controller: session.controller, focusOnAppear: !model.uiTestMode)
                if let exit = session.exit {
                    if exit.notInstalled {
                        InstallCard().padding()
                    } else {
                        ExitBanner(session: session, exit: exit).padding(.bottom, 8)
                    }
                }
            }
            if session.kind == .claude && session.running {
                ClaudeQuickActions(session: session)
            }
            if model.uiTestMode {
                UITestProbe(session: session)
            }
        }
    }
}

struct ExitBanner: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var session: TerminalSession
    let exit: SessionExit

    var body: some View {
        HStack(spacing: 12) {
            Text(exit.code.map { "Exited (\($0))" } ?? "Stopped")
                .font(.footnote.monospaced())
            Button("Restart") { model.restart(session) }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("session.restart")
            Button("Close", role: .destructive) { model.close(session) }
                .buttonStyle(.bordered)
        }
        .padding(10)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

/// Claude Code shortcuts: slash commands and the two keys that are awkward on glass.
struct ClaudeQuickActions: View {
    @ObservedObject var session: TerminalSession

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                action("/compact") { session.send("/compact\r") }
                action("/clear") { session.send("/clear\r") }
                action("Ctrl-C") { session.interrupt() }
                action("Esc") { session.escape() }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(Color(white: 0.11))
    }

    private func action(_ title: String, _ run: @escaping () -> Void) -> some View {
        Button(title, action: run)
            .font(.footnote.monospaced())
            .buttonStyle(.bordered)
            .accessibilityIdentifier("quick.\(title)")
    }
}

/// Only with -UITestMode: exposes the screen text and a direct input line to XCUITest.
struct UITestProbe: View {
    @ObservedObject var session: TerminalSession
    @State private var input = ""

    var body: some View {
        VStack(spacing: 0) {
            TextField("uitest input", text: $input)
                .font(.caption2.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    session.send(input + "\r")
                    input = ""
                }
                .accessibilityIdentifier("uitest.input")
            Text(session.screenSnapshot)
                .font(.system(size: 2))
                .frame(height: 4)
                .accessibilityIdentifier("uitest.screen")
                .accessibilityLabel(session.screenSnapshot)
        }
    }
}
