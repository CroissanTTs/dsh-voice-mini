import SwiftUI

// The whole pet is drawn with shapes — no image assets. The window itself is
// 72x72 collapsed (a 62pt orb plus room for its glow) and 300x260 expanded.

enum PetPalette {
  static let idleTop = Color(red: 0.40, green: 0.51, blue: 1.00)
  static let idleBottom = Color(red: 0.15, green: 0.22, blue: 0.70)
  static let speakTop = Color(red: 0.52, green: 0.96, blue: 1.00)
  static let speakBottom = Color(red: 0.10, green: 0.55, blue: 0.92)
  static let alertTop = Color(red: 1.00, green: 0.79, blue: 0.30)
  static let alertBottom = Color(red: 0.91, green: 0.51, blue: 0.05)
  static let offlineTop = Color(red: 0.44, green: 0.45, blue: 0.49)
  static let offlineBottom = Color(red: 0.23, green: 0.24, blue: 0.27)
}

// MARK: - Root

struct PetRootView: View {
  @ObservedObject var model: PetModel

  static let cardSize = CGSize(width: 300, height: 260)
  static let orbSize: CGFloat = 62

  var body: some View {
    ZStack(alignment: .topTrailing) {
      if model.expanded {
        // Top-trailing so the growing window reveals the card from the anchored corner.
        PetCardView(model: model)
          .frame(width: Self.cardSize.width, height: Self.cardSize.height)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
      } else {
        PetOrbView(model: model)
          .frame(width: Self.orbSize, height: Self.orbSize)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .environment(\.colorScheme, .dark)
  }
}

// MARK: - Orb

struct PetOrbView: View {
  @ObservedObject var model: PetModel

  @State private var breathe = false
  @State private var bounce = false

  private var mood: PetModel.Mood { model.mood }

  var body: some View {
    ZStack {
      Circle().fill(
        LinearGradient(
          colors: [gradientTop, gradientBottom],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
      )
      Circle().strokeBorder(Color.white.opacity(mood == .offline ? 0.12 : 0.24), lineWidth: 1)
      face
        .opacity(mood == .offline ? 0.75 : 1)
    }
    .shadow(color: glow.opacity(glowOpacity), radius: glowRadius)
    .scaleEffect(breathe ? 1.04 : 1.0)
    .offset(y: mood == .attention ? (bounce ? -3 : 1.5) : 0)
    .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: breathe)
    .animation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true), value: bounce)
    .animation(.easeInOut(duration: 0.25), value: mood)
    .onAppear {
      breathe = true
      bounce = true
    }
  }

  @ViewBuilder private var face: some View {
    VStack(spacing: 6) {
      Eyes(blinking: model.blinking || mood == .offline)
      switch mood {
      case .speaking:
        Waveform(phase: model.wave)
      case .attention:
        Capsule().fill(Color.white.opacity(0.95)).frame(width: 6, height: 7)
      case .offline:
        Text("!").font(.system(size: 14, weight: .heavy)).foregroundStyle(.white.opacity(0.9))
      case .idle:
        SmileView().frame(width: 13, height: 6)
      }
    }
  }

  private var gradientTop: Color {
    switch mood {
    case .offline: return PetPalette.offlineTop
    case .attention: return PetPalette.alertTop
    case .speaking: return PetPalette.speakTop
    case .idle: return PetPalette.idleTop
    }
  }

  private var gradientBottom: Color {
    switch mood {
    case .offline: return PetPalette.offlineBottom
    case .attention: return PetPalette.alertBottom
    case .speaking: return PetPalette.speakBottom
    case .idle: return PetPalette.idleBottom
    }
  }

  private var glow: Color {
    switch mood {
    case .offline: return .clear
    case .attention: return PetPalette.alertTop
    case .speaking: return PetPalette.speakTop
    case .idle: return PetPalette.idleTop
    }
  }

  private var glowOpacity: Double {
    switch mood {
    case .offline: return 0
    case .attention: return 0.55
    // The speaking glow breathes with the waveform.
    case .speaking: return 0.35 + 0.35 * abs(sin(model.wave))
    case .idle: return 0.30
    }
  }

  private var glowRadius: CGFloat {
    mood == .speaking ? 8 + CGFloat(abs(sin(model.wave))) * 7 : 7
  }
}

// MARK: - Parts

struct Eyes: View {
  var blinking: Bool

  var body: some View {
    HStack(spacing: 10) {
      eye
      eye
    }
  }

  private var eye: some View {
    Capsule()
      .fill(Color.white.opacity(0.95))
      .frame(width: 7.5, height: blinking ? 1.8 : 10)
  }
}

struct Smile: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    path.addQuadCurve(
      to: CGPoint(x: rect.maxX, y: rect.minY),
      control: CGPoint(x: rect.midX, y: rect.maxY)
    )
    return path
  }
}

struct SmileView: View {
  var body: some View {
    Smile().stroke(Color.white.opacity(0.95), style: StrokeStyle(lineWidth: 2, lineCap: .round))
  }
}

struct Waveform: View {
  var phase: Double
  private let bars = 5

  var body: some View {
    HStack(alignment: .center, spacing: 2.5) {
      ForEach(0..<bars, id: \.self) { index in
        Capsule()
          .fill(Color.white.opacity(0.95))
          .frame(width: 3, height: height(index))
      }
    }
    .frame(height: 16)
    .animation(.easeInOut(duration: 0.1), value: phase)
  }

  private func height(_ index: Int) -> CGFloat {
    let wave = abs(sin(phase + Double(index) * 0.9))
    return 4 + CGFloat(wave) * 11
  }
}

// MARK: - Expanded card

struct PetCardView: View {
  @ObservedObject var model: PetModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("语音宠物 (原型)")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)

      Text(model.statusLabel)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(statusColor)
        .lineLimit(1)
        .padding(.top, 3)

      VStack(alignment: .leading, spacing: 1) {
        Text("最后朗读 / last")
          .font(.system(size: 9))
          .foregroundStyle(.white.opacity(0.45))
        Text(model.lastText ?? "（还没有朗读内容）")
          .font(.system(size: 11))
          .foregroundStyle(.white.opacity(0.85))
          .lineLimit(2)
          .truncationMode(.tail)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.top, 8)

      Divider()
        .overlay(Color.white.opacity(0.12))
        .padding(.vertical, 8)

      VStack(spacing: 4) {
        toggleRow("readReplies", "朗读回复", "read replies")
        toggleRow("chimeEnabled", "提示音", "chime")
        toggleRow("statusEnabled", "状态播报", "status")
      }

      HStack(spacing: 8) {
        Button {
          model.runTest()
        } label: {
          Text("试听")
        }
        .controlSize(.small)
        .buttonStyle(.borderedProminent)
        .tint(PetPalette.idleTop)

        if model.attention != nil {
          Button {
            model.clearAttention()
          } label: {
            Text("清空提醒")
          }
          .controlSize(.small)
          .buttonStyle(.bordered)
        }

        Spacer(minLength: 0)
      }
      .padding(.top, 10)

      Spacer(minLength: 6)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 5) {
          Circle()
            .fill(statusColor)
            .frame(width: 6, height: 6)
          Text(model.linkLabel)
            .font(.system(size: 9.5))
            .foregroundStyle(.white.opacity(0.55))
          if model.queueDepth > 0 {
            Text("队列 \(model.queueDepth)")
              .font(.system(size: 9.5))
              .foregroundStyle(.white.opacity(0.55))
          }
          Spacer(minLength: 0)
        }
        if let footnote = model.footnote {
          Text(footnote)
            .font(.system(size: 9))
            .foregroundStyle(moodColor.opacity(0.85))
            .lineLimit(2)
        }
      }
    }
    .padding(14)
    .frame(
      width: PetRootView.cardSize.width,
      height: PetRootView.cardSize.height,
      alignment: .topLeading
    )
    .background(Color.black.opacity(0.34))
    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
  }

  private func toggleRow(_ key: String, _ title: String, _ hint: String) -> some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(.white.opacity(0.9))
      Text(hint)
        .font(.system(size: 9))
        .foregroundStyle(.white.opacity(0.40))
      Spacer(minLength: 6)
      Toggle("", isOn: Binding(get: { model.isOn(key) }, set: { model.setFlag(key, $0) }))
        .labelsHidden()
        .toggleStyle(.switch)
        .controlSize(.mini)
        .tint(PetPalette.idleTop)
    }
    .frame(height: 20)
  }

  private var statusColor: Color {
    moodColor
  }

  private var moodColor: Color {
    switch model.mood {
    case .offline: return PetPalette.offlineTop
    case .attention: return PetPalette.alertTop
    case .speaking: return PetPalette.speakTop
    case .idle: return .white.opacity(0.75)
    }
  }
}