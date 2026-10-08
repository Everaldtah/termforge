// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TerminalUI",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "TerminalUI", targets: ["TerminalUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.19.0"),
    ],
    targets: [
        .target(name: "TerminalUI", dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")], path: "Sources/TerminalUI"),
    ]
)
