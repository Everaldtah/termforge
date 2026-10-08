import NodeCore
import SwiftUI

/// Shown in a Claude Code tab until Claude Code is installed.
struct InstallCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Install Claude Code").font(.headline)
            Text("TermForge downloads Claude Code \(model.claude?.pinned ?? "") from the npm registry on this device and checks its SHA-512 before unpacking it. It is not bundled with the app.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            InstallControls()
        }
        .padding()
        .frame(maxWidth: 520)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("install.card")
    }
}

struct InstallControls: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.installing {
                if let p = model.installProgress {
                    ProgressView(value: p)
                } else {
                    ProgressView()
                }
            } else {
                Button(model.claude?.installed == nil ? "Install" : "Reinstall") { model.installClaude() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isReady)
                    .accessibilityIdentifier("install.button")
            }
            if let message = model.installMessage {
                Text(message).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }

    private var isReady: Bool {
        if case .ready = model.runtimeState { return true }
        return false
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey = ""
    @State private var pingMs: Double?
    @State private var customPin = PackagePin(name: "@anthropic-ai/claude-code", version: "", tarball: "", integrity: "")

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if model.hasAPIKey {
                        LabeledContent("Anthropic API key", value: "Saved in Keychain")
                        Button("Remove key", role: .destructive) { model.deleteAPIKey() }
                    } else {
                        SecureField("sk-ant-…", text: $apiKey)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("settings.apikey")
                        Button("Save to Keychain") {
                            model.saveAPIKey(apiKey)
                            apiKey = ""
                        }
                        .disabled(apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Authentication")
                } footer: {
                    Text("New Claude Code tabs get the key as ANTHROPIC_API_KEY. Without a key, use /login inside Claude Code to sign in with your Claude account; its credentials are kept in ~/.claude.")
                }

                Section("Claude Code") {
                    LabeledContent("Pinned version", value: model.claude?.pinned ?? "–")
                    LabeledContent("Installed", value: model.claude?.installed ?? "no")
                    InstallControls()
                }

                if AppModel.allowsCustomPins {
                    Section {
                        TextField("version", text: $customPin.version)
                        TextField("tarball URL", text: $customPin.tarball)
                        TextField("integrity (sha512-…)", text: $customPin.integrity)
                        Button("Install this version") { model.installClaude(pin: customPin) }
                            .disabled(customPin.version.isEmpty || customPin.tarball.isEmpty || customPin.integrity.isEmpty)
                    } header: {
                        Text("Custom Claude Code pin (sideload build)")
                    } footer: {
                        Text("Any version that ships cli.js (2.1.112 or older) and runs on Node 18.")
                    }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                }

                Section("Runtime") {
                    switch model.runtimeState {
                    case .ready(let hello):
                        LabeledContent("Node", value: hello.node)
                        LabeledContent("V8", value: hello.v8)
                        LabeledContent("Mode", value: hello.jitless ? "jitless (interpreter)" : "JIT")
                        LabeledContent("Platform", value: "\(hello.platform)/\(hello.arch)")
                        if let ms = model.runtime.timings.startupMs {
                            LabeledContent("Start to ready", value: String(format: "%.0f ms", ms))
                        }
                        LabeledContent("Supervisor load", value: String(format: "%.0f ms", hello.supervisorMs))
                        Button("Measure control round trip") {
                            Task {
                                var samples: [Double] = []
                                for _ in 0..<20 { if let ms = try? await model.runtime.ping() { samples.append(ms) } }
                                pingMs = samples.sorted()[safe: samples.count / 2]
                            }
                        }
                        if let pingMs { LabeledContent("Round trip (median of 20)", value: String(format: "%.2f ms", pingMs)) }
                    case .starting, .idle:
                        Text("Starting…")
                    case .stopped(let why):
                        Text(why).font(.footnote.monospaced())
                    }
                }

                if let session = model.selected, let node = session.node {
                    Section("Current tab") {
                        if let ms = node.firstOutputMs { LabeledContent("Open to first output", value: String(format: "%.0f ms", ms)) }
                        ForEach(node.metrics.sorted(by: { $0.key < $1.key }), id: \.key) { name, ms in
                            LabeledContent(name, value: String(format: "%.0f ms", ms))
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
