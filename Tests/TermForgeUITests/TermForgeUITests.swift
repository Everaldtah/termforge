import XCTest

final class TermForgeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-UITestMode"]
        app.launch()
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private var screen: XCUIElement { app.staticTexts["uitest.screen"] }

    private func screenText() -> String {
        screen.exists ? screen.label : ""
    }

    @discardableResult
    private func waitForScreen(containing needle: String, timeout: TimeInterval = 30) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if screenText().contains(needle) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTFail("screen never showed \"\(needle)\"; it shows:\n\(screenText())")
        return false
    }

    private func type(_ line: String) {
        let input = app.textFields["uitest.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText(line + "\n")
    }

    /// Fresh install: the first tab is a Node REPL (Claude Code is not installed yet).
    func testReplRoundTrip() {
        XCTAssertTrue(app.descendants(matching: .any)["tab.repl"].waitForExistence(timeout: 60))
        waitForScreen(containing: "> ")
        type("6*7")
        waitForScreen(containing: "42")
    }

    func testSurvivesRotationAndSuspendResume() {
        XCTAssertTrue(app.descendants(matching: .any)["tab.repl"].waitForExistence(timeout: 60))
        waitForScreen(containing: "> ")
        XCUIDevice.shared.orientation = .landscapeLeft
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        type("1+1")
        waitForScreen(containing: "2")
        XCUIDevice.shared.orientation = .portrait

        XCUIDevice.shared.press(.home)
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        type("'after'+'resume'")
        waitForScreen(containing: "afterresume")
    }

    /// Installs the pinned Claude Code from registry.npmjs.org inside the simulator and checks
    /// that its first screen renders. Needs network; reports the time to that screen.
    func testInstallAndStartClaudeCode() throws {
        XCTAssertTrue(app.descendants(matching: .any)["tab.repl"].waitForExistence(timeout: 60))
        app.buttons["tabs.new"].tap()
        app.buttons["new.claude"].tap()
        let scratch = app.buttons["Scratch"]
        XCTAssertTrue(scratch.waitForExistence(timeout: 10))
        scratch.tap()

        // the unit tests may already have installed it into this simulator: then the tab
        // starts Claude Code directly instead of showing the install card
        let install = app.buttons["install.button"]
        let started = Date()
        let decide = Date().addingTimeInterval(30)
        while Date() < decide {
            if install.exists {
                install.tap()
                break
            }
            if screenText().contains("Claude Code") { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }

        let deadline = started.addingTimeInterval(300)
        var seen = ""
        while Date() < deadline {
            seen = screenText()
            if seen.contains("Welcome to Claude Code") || seen.contains("Choose the text style") { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        XCTAssertTrue(seen.contains("Claude Code") || seen.contains("Choose the text style"),
                      "Claude Code did not render its first screen; screen:\n\(seen)\nUI:\n\(app.debugDescription)")
        print(String(format: "METRIC uitest.installTapToClaudeScreen %.0f ms", Date().timeIntervalSince(started) * 1000))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "claude-code-first-screen"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
