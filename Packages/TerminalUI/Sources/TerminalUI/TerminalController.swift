import SwiftTerm
import SwiftUI
import UIKit

/// Owns one SwiftTerm view for the lifetime of a session, so switching tabs, rotating or
/// backgrounding re-attaches the same screen and scrollback instead of rebuilding them.
@MainActor
public final class TerminalController: NSObject, @preconcurrency TerminalViewDelegate {
    public let view: TerminalView

    /// Bytes the user typed or pasted (already encoded by the terminal: keys, bracketed paste, mouse).
    public var onInput: (([UInt8]) -> Void)?
    public var onResize: ((Int, Int) -> Void)?
    public var onTitle: ((String) -> Void)?
    public var onOpenLink: ((URL) -> Void)?

    public private(set) var cols: Int
    public private(set) var rows: Int

    public init(fontSize: CGFloat = 13, scrollback: Int = 10_000) {
        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view = TerminalView(frame: CGRect(x: 0, y: 0, width: 640, height: 480), font: font)
        cols = view.getTerminal().cols
        rows = view.getTerminal().rows
        super.init()
        view.terminalDelegate = self
        view.inputAccessoryView = ExtraKeysBar(terminal: view)
        view.changeScrollback(scrollback)
        view.nativeBackgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1)
        view.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
        view.optionAsMetaKey = true
        view.accessibilityIdentifier = "terminal"
    }

    /// Program output -> screen. SwiftTerm batches redraws, so bursts cost one display pass.
    public func feed(_ bytes: ArraySlice<UInt8>) {
        view.feed(byteArray: bytes)
    }

    public func feed(text: String) {
        view.feed(text: text)
    }

    @discardableResult
    public func focus() -> Bool {
        view.becomeFirstResponder()
    }

    /// The visible screen as plain text (diagnostics and UI tests).
    public func screenText() -> String {
        let terminal = view.getTerminal()
        var lines: [String] = []
        for row in 0..<terminal.rows {
            guard let line = terminal.getLine(row: row) else { continue }
            lines.append(line.translateToString(trimRight: true))
        }
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        return lines.joined(separator: "\n")
    }

    // MARK: TerminalViewDelegate

    public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard newCols != cols || newRows != rows else { return }
        cols = newCols
        rows = newRows
        onResize?(newCols, newRows)
    }

    public func setTerminalTitle(source: TerminalView, title: String) {
        onTitle?(title)
    }

    public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    public func send(source: TerminalView, data: ArraySlice<UInt8>) {
        onInput?(Array(data))
    }

    public func scrolled(source: TerminalView, position: Double) {}

    public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        if let url = URL(string: link) { onOpenLink?(url) }
    }

    public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    /// OSC 52 writes go to the system pasteboard; reads are refused so programs cannot
    /// silently read what the user copied elsewhere.
    public func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
    }

    public func clipboardRead(source: TerminalView) -> Data? { nil }
}

/// Hosts a controller's terminal view in SwiftUI. The view is moved, not recreated, when
/// SwiftUI rebuilds this representable. It takes keyboard focus when it first appears
/// (a new tab, or switching tabs); after that, focus follows the user's taps.
public struct TerminalHostView: UIViewRepresentable {
    public let controller: TerminalController
    public var focusOnAppear: Bool

    public init(controller: TerminalController, focusOnAppear: Bool = true) {
        self.controller = controller
        self.focusOnAppear = focusOnAppear
    }

    public func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = controller.view.nativeBackgroundColor
        attach(to: container)
        if focusOnAppear {
            DispatchQueue.main.async { [controller] in controller.focus() }
        }
        return container
    }

    public func updateUIView(_ container: UIView, context: Context) {
        if controller.view.superview !== container { attach(to: container) }
    }

    private func attach(to container: UIView) {
        let tv = controller.view
        tv.removeFromSuperview()
        tv.frame = container.bounds
        tv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(tv)
    }
}
