// swift-tools-version: 5.10
import PackageDescription

// NodeMobile.xcframework is fetched by scripts/fetch-nodejs-mobile.sh (pinned version + SHA-256)
// into Vendor/; it is not committed.
let package = Package(
    name: "NodeCore",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "NodeCore", targets: ["NodeCore"]),
    ],
    targets: [
        .binaryTarget(name: "NodeMobile", path: "Vendor/NodeMobile.xcframework"),
        .target(name: "NodeCore", dependencies: ["NodeMobile"], path: "Sources/NodeCore"),
    ]
)
