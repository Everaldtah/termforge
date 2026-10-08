// swift-tools-version: 5.10
import PackageDescription

// iSHCore.xcframework (iSH kernel + x86 emulator + fakefs + libarchive + TermForge's shim,
// GPL-3.0) is fetched by scripts/fetch-ish.sh into Vendor/; it is not committed.
let package = Package(
    name: "LinuxCore",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "LinuxCore", targets: ["LinuxCore"]),
    ],
    targets: [
        .binaryTarget(name: "iSHCore", path: "Vendor/iSHCore.xcframework"),
        .target(
            name: "LinuxCore",
            dependencies: ["iSHCore"],
            path: "Sources/LinuxCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
    ]
)
