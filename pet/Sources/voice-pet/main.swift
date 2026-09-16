import AppKit
import SwiftUI

// Entry point. `--selftest` is handled before anything touches AppKit, so it
// runs headless (no NSApplication, no window) and can verify a build over SSH.

if CommandLine.arguments.contains("--selftest") {
  exit(Selftest.run())
}

VoicePetApp.run()

enum VoicePetApp {
  static func run() {
    // Top-level code is already on the main thread; assumeIsolated keeps this
    // callable whatever isolation the compiler infers for main.swift.
    MainActor.assumeIsolated {
      let app = NSApplication.shared
      app.setActivationPolicy(.accessory)
      let delegate = PetAppDelegate()
      PetAppDelegate.hold = delegate
      app.delegate = delegate
      app.run()
    }
  }
}

@MainActor
final class PetAppDelegate: NSObject, NSApplicationDelegate {
  /// NSApplication.delegate is weak — hold the delegate for the process lifetime.
  static var hold: PetAppDelegate?

  private let collapsedSize = NSSize(width: 72, height: 72)
  private let expandedSize = NSSize(
    width: PetRootView.cardSize.width,
    height: PetRootView.cardSize.height
  )
  private let edgeMargin: CGFloat = 14
  private let collapseDelay: TimeInterval = 0.4

  private let model = PetModel()
  private var panel: PetPanel?
  private var hosting: PetHostingView<PetRootView>?
  private var hoverTimer: Timer?
  private var collapseWork: DispatchWorkItem?
  private var entered = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    ProcessInfo.processInfo.disableAutomaticTermination("voice-pet")
    ProcessInfo.processInfo.disableSuddenTermination()

    let panel = PetPanel(size: collapsedSize)
    let hosting = PetHostingView(rootView: PetRootView(model: model))
    hosting.sizingOptions = []
    hosting.wantsLayer = true
    hosting.layer?.isOpaque = false
    hosting.layer?.backgroundColor = NSColor.clear.cgColor
    panel.embedHost(hosting)
    panel.setCornerRadius(cornerRadius(expanded: false))
    panel.ignoresMouseEvents = false
    self.panel = panel
    self.hosting = hosting

    pinToScreen()
    panel.orderFrontRegardless()
    model.start()

    // Same hover probe as dsh-notch: a repeating 0.05s mouse-location check.
    let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tickHover() }
    }
    RunLoop.main.add(timer, forMode: .common)
    hoverTimer = timer

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(pinToScreen),
      name: NSApplication.didChangeScreenParametersNotification,
      object: nil
    )
  }

  // MARK: Placement

  /// Right edge of the screen under the mouse, vertically centered, top-right
  /// corner fixed so the anchored resize grows left and down.
  @objc private func pinToScreen() {
    guard let panel else { return }
    panel.cancelResize()
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
      ?? NSScreen.main
      ?? NSScreen.screens.first
    guard let screen else { return }
    let visible = screen.visibleFrame
    let size = panel.frame.size == .zero ? collapsedSize : panel.frame.size
    let top = visible.midY + collapsedSize.height / 2
    panel.setFrame(
      NSRect(
        x: visible.maxX - edgeMargin - size.width,
        y: top - size.height,
        width: size.width,
        height: size.height
      ),
      display: true
    )
  }

  // MARK: Hover

  private func tickHover() {
    guard let panel else { return }
    guard panel.frame.contains(NSEvent.mouseLocation) else {
      guard model.expanded, entered, collapseWork == nil else { return }
      let work = DispatchWorkItem { [weak self] in
        Task { @MainActor in self?.collapseIfStillOutside() }
      }
      collapseWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + collapseDelay, execute: work)
      return
    }
    entered = true
    collapseWork?.cancel()
    collapseWork = nil
    guard !model.expanded else { return }
    model.expanded = true
    applyLayout()
  }

  private func collapseIfStillOutside() {
    guard let panel else { return }
    collapseWork = nil
    guard !panel.frame.contains(NSEvent.mouseLocation) else { return }
    entered = false
    model.expanded = false
    applyLayout()
  }

  private func applyLayout() {
    guard let panel else { return }
    let expanded = model.expanded
    panel.setCornerRadius(cornerRadius(expanded: expanded))
    panel.resizeAnchored(to: expanded ? expandedSize : collapsedSize, animated: true)
    panel.orderFrontRegardless()
  }

  /// 36 = half of the collapsed panel, i.e. the orb mask is a circle.
  private func cornerRadius(expanded: Bool) -> CGFloat {
    expanded ? 20 : collapsedSize.width / 2
  }
}
