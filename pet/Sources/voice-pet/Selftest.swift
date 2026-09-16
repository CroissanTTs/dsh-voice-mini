import Foundation

/// Headless verification mode: `voice-pet --selftest`.
///
/// Resolves the runtime file, calls `GET /voice-mini/pet/state` with the bearer
/// token and prints the raw JSON. Never creates a window or an NSApplication, so
/// it is usable from a build machine with no GUI session.
///
/// Exit codes: 0 success · 1 request/decode failure · 2 runtime file missing.
enum Selftest {
  static func run() -> Int32 {
    let box = ExitBox()
    let finished = DispatchSemaphore(value: 0)
    // Network work off the main thread; the main thread only waits on the handle.
    Task.detached {
      box.value = await perform()
      finished.signal()
    }
    finished.wait()
    return box.value
  }

  private static func perform() async -> Int32 {
    let url = PetClient.runtimeFileURL
    let client = PetClient()

    print("== voice-pet selftest ==")
    print("runtime file : \(url.path)")
    print("resolution   : \(resolution())")
    print("exists       : \(fileExists(url) ? "yes" : "no")")

    guard fileExists(url) else {
      print("")
      print("FAIL: runtime file not found.")
      print("      The dsh-voice-mini host writes it while the plugin is running.")
      print("      Point somewhere else with DSH_VOICE_PET_RUNTIME_FILE=/path/to/runtime.json")
      return 2
    }

    do {
      let (snapshot, raw) = try await client.state()
      print("origin       : \(client.origin)")
      print("token        : \(client.tokenLength) chars (not printed)")
      print("")
      print("GET /voice-mini/pet/state -> 200 OK")
      print(pretty(raw) ?? String(data: raw, encoding: .utf8) ?? "<undecodable body>")
      print("")
      print(
        "parsed       : ok=\(snapshot.ok.map(String.init) ?? "null")"
          + " speaking=\(snapshot.isSpeaking)"
          + " queued=\(snapshot.queueDepth)"
          + " attention=\(snapshot.attention ?? "null")"
      )
      return 0
    } catch {
      print("")
      print("FAIL: \(error.localizedDescription)")
      return 1
    }
  }

  private static func resolution() -> String {
    let env = ProcessInfo.processInfo.environment["DSH_VOICE_PET_RUNTIME_FILE"]
    if let env, !env.isEmpty { return "DSH_VOICE_PET_RUNTIME_FILE=\(env)" }
    return "default (~/\(PetClient.defaultRuntimePath))"
  }

  private static func fileExists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
  }

  private static func pretty(_ data: Data) -> String? {
    guard
      let object = try? JSONSerialization.jsonObject(with: data),
      let pretty = try? JSONSerialization.data(
        withJSONObject: object,
        options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      )
    else { return nil }
    return String(data: pretty, encoding: .utf8)
  }
}

/// Mutable slot shared with the detached task before the semaphore is signalled.
private final class ExitBox: @unchecked Sendable {
  var value: Int32 = 1
}