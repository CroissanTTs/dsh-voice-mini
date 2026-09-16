import Foundation
import SwiftUI

/// Everything the pet knows. Owns the 0.5s poll and the small idle tickers so the
/// SwiftUI views stay purely presentational (their publishers would otherwise be
/// recreated — and restarted — on every parent render).
@MainActor
final class PetModel: ObservableObject {
  enum Link: Equatable {
    case connecting
    case connected
    case failed(String)
  }

  /// What the orb should look like right now.
  enum Mood {
    case offline
    case idle
    case speaking
    case attention
  }

  @Published private(set) var snapshot: PetSnapshot?
  @Published private(set) var link: Link = .connecting
  @Published private(set) var actionNote: String?
  @Published private(set) var blinking = false
  /// Rising phase for the speaking waveform (only published while speaking).
  @Published private(set) var wave: Double = 0
  /// Panel is expanded (hover). Drives both the window size and the content.
  @Published var expanded = false

  private let client = PetClient()
  private var pollTimer: Timer?
  private var waveTimer: Timer?
  private var blinkTimer: Timer?
  private var blinkReset: DispatchWorkItem?
  private var refreshing = false
  /// Optimistic switch positions, cleared once the host echoes the same value.
  private var overrides: [String: Bool] = [:]

  // MARK: Derived state

  var isConnected: Bool {
    if case .connected = link { return true }
    return false
  }

  var mood: Mood {
    guard isConnected else { return .offline }
    if attention != nil { return .attention }
    if snapshot?.isSpeaking == true { return .speaking }
    return .idle
  }

  var speaking: Bool { isConnected && (snapshot?.isSpeaking ?? false) }
  var attention: String? { isConnected ? snapshot?.attention : nil }
  var attentionText: String? { isConnected ? snapshot?.alertText : nil }
  var queueDepth: Int { isConnected ? (snapshot?.queueDepth ?? 0) : 0 }
  var lastText: String? { snapshot?.lastText }
  var failureText: String? {
    if case .failed(let message) = link { return message }
    return nil
  }

  var linkLabel: String {
    switch link {
    case .connecting: return "连接中 / connecting"
    case .connected: return "已连接 / connected"
    case .failed: return "未连接 / not connected"
    }
  }

  var statusLabel: String {
    switch mood {
    case .offline: return "未连接 / not connected"
    case .attention: return attentionText ?? "需要你处理 / attention"
    case .speaking: return "正在朗读 / speaking"
    case .idle: return "空闲 / idle"
    }
  }

  var footnote: String? {
    if let actionNote { return actionNote }
    if let error = snapshot?.lastError?.trimmingCharacters(in: .whitespacesAndNewlines),
       !error.isEmpty {
      return "host: \(error)"
    }
    return failureText
  }

  // MARK: Lifecycle

  func start() {
    poll()
    pollTimer = schedule(0.5) { [weak self] in self?.poll() }
    waveTimer = schedule(0.1) { [weak self] in self?.tickWave() }
    blinkTimer = schedule(3.4) { [weak self] in self?.tickBlink() }
  }

  private func schedule(_ interval: TimeInterval, _ body: @escaping @MainActor () -> Void) -> Timer {
    // .common so hovering (a tracking mode) never stalls the pet.
    let timer = Timer(timeInterval: interval, repeats: true) { _ in
      Task { @MainActor in body() }
    }
    RunLoop.main.add(timer, forMode: .common)
    return timer
  }

  // MARK: Polling

  private func poll() {
    guard !refreshing else { return }
    refreshing = true
    Task { [weak self] in
      guard let self else { return }
      await self.refresh()
      self.refreshing = false
    }
  }

  private func refresh() async {
    do {
      let (snap, _) = try await client.state()
      snapshot = snap
      link = .connected
      // Drop optimistic values the host now confirms.
      overrides = overrides.filter { key, value in snap.config?.flag(key) != value }
    } catch {
      link = .failed(error.localizedDescription)
    }
  }

  private func tickWave() {
    guard mood == .speaking else { return }
    // Keep the phase small so a long utterance cannot lose float precision.
    wave = (wave + 0.85).truncatingRemainder(dividingBy: 1000)
  }

  private func tickBlink() {
    guard mood != .offline else { return }
    blinking = true
    let work = DispatchWorkItem { [weak self] in
      Task { @MainActor in self?.blinking = false }
    }
    blinkReset?.cancel()
    blinkReset = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
  }

  // MARK: Config switches

  func isOn(_ key: String) -> Bool {
    if let value = overrides[key] { return value }
    return snapshot?.config?.flag(key) ?? PetConfig.assumed[key] ?? false
  }

  func setFlag(_ key: String, _ value: Bool) {
    overrides[key] = value
    actionNote = nil
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.client.setConfig([key: value])
        await self.refresh()
      } catch {
        self.overrides[key] = nil
        self.actionNote = "设置失败 / failed: \(error.localizedDescription)"
      }
    }
  }

  // MARK: Actions

  func runTest() {
    actionNote = "已请求试听 / test requested"
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.client.test()
      } catch {
        self.actionNote = "试听失败 / test failed: \(error.localizedDescription)"
      }
    }
  }

  func clearAttention() {
    actionNote = nil
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.client.clearAttention()
        await self.refresh()
      } catch {
        self.actionNote = "清空失败 / clear failed: \(error.localizedDescription)"
      }
    }
  }
}