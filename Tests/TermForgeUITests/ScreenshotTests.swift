import XCTest

/// App Store screenshots, run by .github/workflows/screenshots.yml on a 6.9-inch iPhone and a
/// 13-inch iPad simulator. It drives the real app with nothing mocked: a Linux shell session
/// typed on the software keyboard, Claude Code's install card and first-run screen, Settings.
/// Full-screen PNGs go to $SCREENSHOT_DIR (TEST_RUNNER_SCREENSHOT_DIR in the workflow) and
/// into the result bundle. Skipped when SCREENSHOT_DIR is unset (the CI test run).
final class ScreenshotTests: XCTestCase {
    private var app: XCUIApplication!
    private var outDir: URL!
    private var typesWithXCTest = true

    override func setUpWithError() throws {
        let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"] ?? ""
        try XCTSkipIf(dir.isEmpty, "App Store screenshots run from screenshots.yml only (SCREENSHOT_DIR is unset)")
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        app.launchArguments = ["-ScreenshotMode"]
        app.launch()
    }

    func testAppStoreScreenshots() {
        XCTAssertTrue(app.descendants(matching: .any)["tab.repl"].waitForExistence(timeout: 60))
        waitForScreen(containing: "> ")

        // Linux tab: install the Alpine root (download + import + boot), then type real commands
        app.buttons["tabs.new"].tap()
        app.buttons["new.linux"].tap()
        let installLinux = app.buttons["linux.install.button"]
        let decide = Date().addingTimeInterval(30)
        while Date() < decide {
            if installLinux.exists {
                installLinux.tap()
                break
            }
            if screenText().contains("#") { break }
            pause(0.25)
        }
        waitForScreen(containing: "#", timeout: 600)
        pause(1)
        shell("uname -a", until: "Linux")
        shell("cat /etc/os-release", until: "VERSION_ID")
        shell("git --version", until: "git version")
        shell("python3 -c 'print(2**100)'", until: "1267650600228229401496703205376")
        shell("ls /mnt/termforge", until: "Projects")
        shell("rg -in termforge /etc", until: "TERMFORGE_HOME")
        type("cd Projects/Scratch")
        waitForScreen(containing: "cd Projects/Scratch")
        capture("03-keyboard")
        type("\n")
        pause(1.5)

        // Claude Code tab: the install card, then the pinned release's first-run screen
        app.buttons["tabs.new"].tap()
        app.buttons["new.claude"].tap()
        pickScratch()
        let install = app.buttons["install.button"]
        XCTAssertTrue(install.waitForExistence(timeout: 60), "no install card in the Claude Code tab")
        let enabled = Date().addingTimeInterval(60)
        while !install.isEnabled && Date() < enabled { pause(0.25) }
        pause(1.5)
        capture("04-install-card")
        install.tap()
        let deadline = Date().addingTimeInterval(300)
        var seen = ""
        while Date() < deadline {
            seen = screenText().filter { !$0.isWhitespace && $0 != "\u{a0}" }
            if seen.contains("WelcometoClaudeCode") || seen.contains("Choosethetextstyle") { break }
            pause(0.5)
        }
        XCTAssertTrue(seen.contains("WelcometoClaudeCode") || seen.contains("Choosethetextstyle"),
                      "Claude Code did not render its first screen; screen:\n\(screenText())")
        pause(3)
        capture("01-claude-code")

        // an Agent tab, so the strip shows every kind of tab (it waits for a key; none is entered)
        app.buttons["tabs.new"].tap()
        app.buttons["new.agent"].tap()
        pickScratch()
        XCTAssertTrue(app.descendants(matching: .any)["agent.apikey.card"].waitForExistence(timeout: 30))

        // back to the Alpine tab: the whole session at full height
        app.descendants(matching: .any)["tab.linux"].tap()
        waitForScreen(containing: "TERMFORGE_HOME")
        pause(1.5)
        capture("02-linux-shell")

        // Settings, scrolled to the Linux layer and the Node runtime as measured on this device
        app.buttons["tabs.settings"].tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        pause(1)
        let measure = app.buttons["Measure control round trip"]
        let form = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app.tables.firstMatch
        for _ in 0..<6 where !(measure.exists && measure.isHittable) {
            drag(form, by: 0.35)
        }
        if measure.exists && measure.isHittable {
            if measure.frame.maxY > app.windows.firstMatch.frame.height * 0.8 { drag(form, by: 0.2) }
            measure.tap()
            _ = app.staticTexts["Round trip (median of 20)"].waitForExistence(timeout: 15)
        } else {
            print("SHOT| settings: the Runtime section never became visible")
        }
        pause(1)
        capture("05-settings")
    }

    // MARK: driving the app

    private var screen: XCUIElement { app.staticTexts["uitest.screen"] }
    private var terminal: XCUIElement { app.descendants(matching: .any).matching(identifier: "terminal").firstMatch }
    private var keyboard: XCUIElement { app.keyboards.firstMatch }

    private func screenText() -> String {
        screen.exists ? screen.label : ""
    }

    private func pause(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    @discardableResult
    private func waitForScreen(containing needle: String, timeout: TimeInterval = 60) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if screenText().contains(needle) { return true }
            pause(0.2)
        }
        XCTFail("screen never showed \"\(needle)\" (screen element exists: \(screen.exists)); it shows:\n\(screenText())")
        return false
    }

    private func pickScratch() {
        let scratch = app.buttons["Scratch"]
        XCTAssertTrue(scratch.waitForExistence(timeout: 10), "no Scratch project in the picker")
        scratch.tap()
        pause(1)
    }

    /// Scrolls a list up by a fraction of its height, without momentum.
    private func drag(_ view: XCUIElement, by fraction: CGFloat) {
        let start = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        let end = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8 - fraction))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(0.5)
    }

    private func capture(_ name: String) {
        pause(1)
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let size = "\(Int(shot.image.size.width * shot.image.scale))x\(Int(shot.image.size.height * shot.image.scale))"
        let url = outDir.appendingPathComponent(name + ".png")
        do {
            try shot.pngRepresentation.write(to: url)
            print("SHOT| \(name) \(size) -> \(url.path)")
        } catch {
            print("SHOT| \(name) \(size): could not write \(url.path) (\(error.localizedDescription)); the result bundle has it")
        }
    }

    // MARK: typing on the software keyboard

    private func shell(_ command: String, until needle: String) {
        type(command + "\n")
        waitForScreen(containing: needle, timeout: 120)
        pause(0.8)
    }

    private func type(_ text: String) {
        raiseKeyboard()
        if typesWithXCTest { app.typeText(text) } else { tapKeys(text) }
    }

    /// A tap gives the terminal keyboard focus: the system keyboard comes up with TermForge's
    /// extra-keys row on top. XCUITest's typeText needs an element it sees as focused; when
    /// the terminal is not one, the keys are tapped one by one.
    private func raiseKeyboard() {
        guard !keyboard.exists else { return }
        XCTAssertTrue(terminal.waitForExistence(timeout: 10), "no terminal view")
        terminal.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15), "the software keyboard did not come up (hardware keyboard connected?)")
        pause(1)
        for label in ["Continue", "Not Now"] where app.buttons[label].exists {
            app.buttons[label].tap()
            pause(0.5)
        }
        let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).count
        typesWithXCTest = focused > 0
        print("SHOT| keyboard up; \(focused) element(s) with keyboard focus -> \(typesWithXCTest ? "typeText" : "key taps")")
    }

    private static let keyNames: [Character: [String]] = [
        " ": ["space"], "\n": ["Return", "return"], "-": ["-", "hyphen", "dash"], "/": ["/", "slash"],
        "'": ["'", "apostrophe"], "*": ["*", "asterisk"], ".": [".", "period", "full stop"],
    ]

    private func key(_ names: [String]) -> XCUIElement? {
        for name in names {
            let el = keyboard.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR identifier == %@", name, name)).firstMatch
            if el.exists && el.isHittable { return el }
        }
        return nil
    }

    private enum Plane { case letters, numbers, symbols }

    private func plane() -> Plane? {
        if key(["q", "Q"]) != nil { return .letters }
        if key(["["]) != nil { return .symbols }
        if key(["1"]) != nil { return .numbers }
        return nil
    }

    private func switchPlane() {
        switch plane() {
        case .letters?: key(["numbers", "more", "123"])?.tap()
        case .numbers?: key(["symbols", "#+="])?.tap()
        case .symbols?, nil: key(["letters", "ABC"])?.tap()
        }
        pause(0.2)
    }

    private func tapKeys(_ text: String) {
        for ch in text {
            var typed = false
            for _ in 0..<4 {
                if ch.isUppercase, plane() == .letters, let shift = key(["shift"]) {
                    shift.tap()
                    if let k = key([String(ch), ch.lowercased()]) { k.tap(); typed = true; break }
                }
                if let k = key(Self.keyNames[ch] ?? [String(ch)]) { k.tap(); typed = true; break }
                switchPlane()
            }
            if !typed {
                let labels = keyboard.descendants(matching: .any).allElementsBoundByIndex.map(\.label)
                XCTFail("no key for \(ch.debugDescription) on the software keyboard; it shows \(labels)")
                return
            }
        }
    }
}
