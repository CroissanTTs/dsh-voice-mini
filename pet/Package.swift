// swift-tools-version: 6.0
import PackageDescription

// Throwaway prototype: a floating "pet" widget for the dsh-voice-mini plugin.
// No external dependencies — AppKit / SwiftUI / Foundation only.
let package = Package(
  name: "voice-pet",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "voice-pet", targets: ["voice-pet"]),
  ],
  targets: [
    .executableTarget(
      name: "voice-pet",
      path: "Sources/voice-pet"
    ),
  ]
)