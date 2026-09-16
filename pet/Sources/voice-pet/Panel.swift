import AppKit
import SwiftUI

// Window mechanics copied from dsh-notch (macos/Sources/Panel.swift):
// borderless nonactivating NSPanel at .statusBar level, joins all Spaces,
// HUD-blur content view, and a resize that keeps the top-right corner anchored.

enum PetGeometry {
  static let duration: TimeInterval = 0.36
  /// Smoothstep-ish quintic: no overshoot, so the anchored corner never wobbles.
  static func progress(_ t: Double) -> Double {
    let x = min(1, max(0, t))
    return x * x * x * (x * (6 * x - 15) + 10)
  }
}

final class PetPanel: NSPanel {
  private var resizeTimer: Timer?
  private var resizeTarget: NSSize?
  private var resizeGeneration = 0
  private var effectView: NSVisualEffectView?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  convenience init(size: NSSize) {
    self.init(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    level = .statusBar
    collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    isOpaque = false
    backgroundColor = .clear
    appearance = NSAppearance(named: .darkAqua)
    hasShadow = false
    isMovable = false
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = true
    isReleasedWhenClosed = false
  }

  func cancelResize() {
    resizeTimer?.invalidate()
    resizeTimer = nil
    resizeTarget = nil
    resizeGeneration += 1
  }

  /// Animate one native rectangle, preserving its top-right edge at every frame.
  func resizeAnchored(to size: NSSize, animated: Bool = true) {
    guard resizeTarget != size else { return }
    cancelResize()
    let generation = resizeGeneration
    resizeTarget = size
    let start = frame
    let end = NSRect(
      x: start.maxX - size.width,
      y: start.maxY - size.height,
      width: size.width,
      height: size.height
    )
    guard animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
      setFrame(end, display: true)
      return
    }
    let began = ProcessInfo.processInfo.systemUptime
    resizeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.resizeGeneration == generation else { return }
        let t = min(1, (ProcessInfo.processInfo.systemUptime - began) / PetGeometry.duration)
        let progress = PetGeometry.progress(t)
        let width = start.width + (size.width - start.width) * progress
        let height = start.height + (size.height - start.height) * progress
        self.setFrame(
          NSRect(x: start.maxX - width, y: start.maxY - height, width: width, height: height),
          display: true
        )
        if t >= 1 {
          self.resizeTimer?.invalidate()
          self.resizeTimer = nil
        }
      }
    }
  }

  /// The window mask follows the shape: a circle when collapsed, a card when open.
  func setCornerRadius(_ radius: CGFloat) {
    effectView?.layer?.cornerRadius = radius
  }

  /// Put the SwiftUI host on top of a real window-backed HUD blur.
  /// A VisualEffect inside NSHostingView is covered by the hosting view's opaque fill.
  func embedHost(_ hosting: NSView) {
    let effect = NSVisualEffectView(
      frame: contentView?.bounds ?? NSRect(origin: .zero, size: frame.size)
    )
    effect.material = .hudWindow
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.isEmphasized = true
    effect.autoresizingMask = [.width, .height]
    effect.wantsLayer = true
    effect.layer?.masksToBounds = true
    effect.layer?.cornerRadius = 36
    effect.layer?.cornerCurve = .continuous
    effect.appearance = NSAppearance(named: .darkAqua)
    contentView = effect
    effectView = effect

    hosting.autoresizingMask = [.width, .height]
    hosting.frame = effect.bounds
    hosting.wantsLayer = true
    hosting.layer?.isOpaque = false
    hosting.layer?.backgroundColor = NSColor.clear.cgColor
    effect.addSubview(hosting)
  }
}

final class PetHostingView<Content: View>: NSHostingView<Content> {
  override var isOpaque: Bool { false }

  // The panel is intentionally nonactivating. A click must reach SwiftUI
  // controls immediately, even while another app is the active application.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}