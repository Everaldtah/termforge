import NodeCore
import SwiftUI

struct TabStrip: View {
    @EnvironmentObject private var model: AppModel
    @State private var showProjects = false

    var body: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(model.sessions) { session in
                        TabChip(session: session, selected: session.id == model.selectedID)
                            .onTapGesture { model.selectedID = session.id }
                    }
                }
                .padding(.horizontal, 8)
            }
            Menu {
                Button {
                    showProjects = true
                } label: {
                    Label("Claude Code…", systemImage: "sparkles")
                }
                .accessibilityIdentifier("new.claude")
                Button {
                    model.newSession(kind: .linux)
                } label: {
                    Label("Linux shell (Alpine)", systemImage: "terminal")
                }
                .accessibilityIdentifier("new.linux")
                Button {
                    model.newSession(kind: .node(.repl))
                } label: {
                    Label("Node REPL", systemImage: "chevron.left.forwardslash.chevron.right")
                }
                .accessibilityIdentifier("new.repl")
            } label: {
                Image(systemName: "plus").frame(width: 32, height: 32)
            }
            .accessibilityIdentifier("tabs.new")
            Button {
                model.showSettings = true
            } label: {
                Image(systemName: "gearshape").frame(width: 32, height: 32)
            }
            .accessibilityIdentifier("tabs.settings")
            .padding(.trailing, 8)
        }
        .padding(.vertical, 4)
        .background(Color(white: 0.09))
        .sheet(isPresented: $showProjects) {
            ProjectPicker { project in
                showProjects = false
                model.newSession(kind: .node(.claude), project: project)
            }
        }
    }
}

struct TabChip: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var session: TerminalSession
    let selected: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(session.running ? Color.green : Color.gray)
                .frame(width: 6, height: 6)
            Text(session.title)
                .font(.footnote.monospaced())
                .lineLimit(1)
            Button {
                model.close(session)
            } label: {
                Image(systemName: "xmark").font(.caption2)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("tab.close")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(selected ? Color(white: 0.2) : Color(white: 0.13), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tab.\(session.kind.saveName)")
    }
}

/// Folders under ~/Projects (Documents/Projects in the Files app).
struct ProjectPicker: View {
    let onPick: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var folders = Paths.projectFolders()
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Projects") {
                    ForEach(folders, id: \.self) { folder in
                        Button(folder.lastPathComponent) { onPick(folder) }
                    }
                }
                Section("New project") {
                    HStack {
                        TextField("folder name", text: $newName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Create") { create() }
                            .disabled(sanitized.isEmpty)
                    }
                }
            }
            .navigationTitle("Open Claude Code in…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private var sanitized: String {
        newName.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "/", with: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    }

    private func create() {
        let url = Paths.projects.appendingPathComponent(sanitized, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        onPick(url)
    }
}
