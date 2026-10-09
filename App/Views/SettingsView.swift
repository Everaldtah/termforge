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

/// Shown in a Linux tab until the Alpine root is installed.
struct LinuxInstallCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Install the Linux root").font(.headline)
            Text("TermForge downloads an Alpine Linux x86 root (about 100 MB, built by this project's CI from Alpine's own packages), checks its SHA-256, and runs it in the embedded iSH emulator. Your Documents folder appears inside it at /mnt/termforge.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            LinuxInstallControls(layer: model.linux)
        }
        .padding()
        .frame(maxWidth: 520)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linux.install.card")
    }
}

struct LinuxInstallControls: View {
    @ObservedObject var layer: LinuxLayer

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch layer.state {
            case .notInstalled, .failed:
                Button("Install Alpine") { layer.install() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("linux.install.button")
                if case .failed(let why) = layer.state {
                    Text(why).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            case .downloading(let p):
                ProgressView(value: p) { Text("Downloading…") }
            case .importing:
                ProgressView { Text("Converting to the emulator's filesystem…") }
            case .booting:
                ProgressView { Text("Booting…") }
            case .ready:
                Text("Ready").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }
}

/// Shown in an Agent tab until an API key is saved.
struct APIKeyCard: View {
    @EnvironmentObject private var model: AppModel
    @State private var apiKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add an Anthropic API key").font(.headline)
            Text("The Agent tab talks to the Messages API directly with your own key (console.anthropic.com → API keys), so it can use Claude Opus 5.5, Fable 5.1 and the other current models. Usage is billed to that API account, not to a Claude subscription. The key is kept in this device's Keychain.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            SecureField("sk-ant-…", text: $apiKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("agent.apikey")
            Button("Save and start") {
                model.saveAPIKey(apiKey)
                apiKey = ""
            }
            .buttonStyle(.borderedProminent)
            .disabled(apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("agent.apikey.save")
        }
        .padding()
        .frame(maxWidth: 520)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent.apikey.card")
    }
}

/// Shown in a PC tab until a bridge is paired; also the body of the Settings section.
struct PCPairCard: View {
    @EnvironmentObject private var model: AppModel
    var compact = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if compact {
                Text("Pair your computer").font(.headline)
                Text("Run `tools/pc-bridge` (node bridge.mjs) on the PC that has Claude Code signed in. It prints an address and a pairing link: open the link on this phone, or paste the two values here. Claude Code then runs on the PC — current version, your subscription, every model — and this tab is its screen (over Tailscale or your LAN).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            PCPairFields()
        }
        .padding(compact ? 16 : 0)
        .frame(maxWidth: compact ? 520 : .infinity)
        .background(compact ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pc.pair.card")
    }
}

struct PCPairFields: View {
    @EnvironmentObject private var model: AppModel
    @State private var address = PCBridgeSettings.url ?? ""
    @State private var token = ""

    var body: some View {
        TextField("ws://your-pc.tailnet.ts.net:7788", text: $address)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("pc.address")
        SecureField("pairing token", text: $token)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("pc.token")
        Button("Pair") {
            model.pairPC(url: address, token: token, name: URL(string: address)?.host)
            token = ""
        }
        .buttonStyle(.borderedProminent)
        .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || token.trimmingCharacters(in: .whitespaces).isEmpty)
        .accessibilityIdentifier("pc.pair.button")
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage(PCBridgeSettings.cwdKey) private var pcCwd = ""
    @AppStorage(AgentSettings.modelKey) private var agentModel = AgentSettings.defaultModel
    @AppStorage(AgentSettings.effortKey) private var agentEffort = AgentSettings.defaultEffort
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
                    Text("New Claude Code and Agent tabs get the key as ANTHROPIC_API_KEY. Without a key, use /login inside Claude Code to sign in with your Claude account; its credentials are kept in ~/.claude. The Agent tab always needs the key.")
                }

                Section {
                    Picker("Model", selection: $agentModel) {
                        ForEach(AgentSettings.models, id: \.id) { m in Text(m.label).tag(m.id) }
                    }
                    Picker("Effort", selection: $agentEffort) {
                        ForEach(AgentSettings.efforts, id: \.self) { Text($0).tag($0) }
                    }
                } header: {
                    Text("Agent")
                } footer: {
                    Text("Defaults for new Agent tabs; /model and /effort change one tab. The agent uses the Messages API with your API key (billed there), runs its tools in the Linux layer, and is TermForge's own code, not Claude Code.")
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

                Section {
                    if model.pcPaired {
                        LabeledContent("Address", value: PCBridgeSettings.url ?? "")
                        if let name = PCBridgeSettings.name { LabeledContent("Computer", value: name) }
                        TextField("working folder on the PC (optional)", text: $pcCwd)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Unpair", role: .destructive) { model.unpairPC() }
                    } else {
                        PCPairFields()
                    }
                } header: {
                    Text("PC bridge")
                } footer: {
                    Text("Runs the current Claude Code on your computer with its own sign-in and shows it in a \"Claude Code on PC\" tab. Start tools/pc-bridge on the PC; it prints the address and a termforge://pair link.")
                }

                Section("Linux layer") {
                    let layer = model.linux
                    LabeledContent("Root", value: layer.pin.name)
                    LabeledContent("State", value: linuxStateText(layer.state))
                    if let ms = layer.importMs { LabeledContent("Import", value: String(format: "%.0f ms", ms)) }
                    if let ms = layer.bootMs { LabeledContent("Boot", value: String(format: "%.0f ms", ms)) }
                    if layer.state.isReady { LabeledContent("Kernel", value: layer.runtime.version) }
                    LinuxInstallControls(layer: model.linux)
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

private func linuxStateText(_ state: LinuxLayer.State) -> String {
    switch state {
    case .notInstalled: return "not installed"
    case .downloading(let p): return String(format: "downloading %.0f%%", p * 100)
    case .importing: return "importing"
    case .booting: return "booting"
    case .ready: return "running"
    case .failed(let why): return "failed: \(why)"
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
