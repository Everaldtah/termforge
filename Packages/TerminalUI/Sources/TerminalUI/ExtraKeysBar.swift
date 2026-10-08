import SwiftTerm
import UIKit

/// Keyboard accessory row: Esc, Tab, Ctrl, Alt, arrows, |, ~, /.
/// Ctrl and Alt are one-shot modifiers handled by SwiftTerm (they reset after the next key).
public final class ExtraKeysBar: UIInputView {
    private weak var terminal: TerminalView?
    private var ctrlButton: UIButton!
    private var altButton: UIButton!
    private var observers: [NSObjectProtocol] = []

    public init(terminal: TerminalView) {
        self.terminal = terminal
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 44), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        build()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .terminalViewControlModifierReset, object: terminal, queue: .main) { [weak self] _ in
            self?.ctrlButton.isSelected = false
        })
        observers.append(center.addObserver(forName: .terminalViewMetaModifierReset, object: terminal, queue: .main) { [weak self] _ in
            self?.altButton.isSelected = false
        })
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    public override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 44)
    }

    private enum Key {
        case bytes(String, [UInt8])
        case arrow(String, UInt8)
        case ctrl
        case alt
    }

    private func build() {
        let keys: [Key] = [
            .bytes("esc", [0x1b]), .bytes("tab", [0x09]), .ctrl, .alt,
            .arrow("←", 0x44), .arrow("↑", 0x41), .arrow("↓", 0x42), .arrow("→", 0x43),
            .bytes("|", Array("|".utf8)), .bytes("~", Array("~".utf8)), .bytes("/", Array("/".utf8)),
        ]
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        for key in keys {
            stack.addArrangedSubview(button(for: key))
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -4),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    private func button(for key: Key) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.cornerStyle = .medium
        config.contentInsets = NSDirectionalEdgeInsets(top: 2, leading: 2, bottom: 2, trailing: 2)
        let b = UIButton(configuration: config)
        b.titleLabel?.adjustsFontSizeToFitWidth = true
        let title: String
        switch key {
        case .bytes(let t, let bytes):
            title = t
            b.addAction(UIAction { [weak self] _ in self?.send(bytes) }, for: .touchUpInside)
        case .arrow(let t, let final):
            title = t
            b.addAction(UIAction { [weak self] _ in self?.sendArrow(final) }, for: .touchUpInside)
            b.accessibilityLabel = ["←": "left", "↑": "up", "↓": "down", "→": "right"][t]
        case .ctrl:
            title = "ctrl"
            ctrlButton = b
            b.changesSelectionAsPrimaryAction = true
            b.addAction(UIAction { [weak self] _ in self?.terminal?.controlModifier = self?.ctrlButton.isSelected ?? false }, for: .primaryActionTriggered)
        case .alt:
            title = "alt"
            altButton = b
            b.changesSelectionAsPrimaryAction = true
            b.addAction(UIAction { [weak self] _ in self?.terminal?.metaModifier = self?.altButton.isSelected ?? false }, for: .primaryActionTriggered)
        }
        b.setTitle(title, for: .normal)
        b.accessibilityIdentifier = "extrakey.\(b.accessibilityLabel ?? title)"
        return b
    }

    private func send(_ bytes: [UInt8]) {
        UIDevice.current.playInputClick()
        guard let terminal else { return }
        var out = bytes
        if terminal.metaModifier {
            out.insert(0x1b, at: 0)
            terminal.metaModifier = false
        }
        terminal.send(out)
    }

    /// Arrows follow DECCKM: ESC O x in application-cursor mode, ESC [ x otherwise.
    private func sendArrow(_ final: UInt8) {
        guard let terminal else { return }
        let app = terminal.getTerminal().applicationCursor
        send([0x1b, app ? 0x4f : 0x5b, final])
    }
}

extension ExtraKeysBar: UIInputViewAudioFeedback {
    public var enableInputClicksWhenVisible: Bool { true }
}
