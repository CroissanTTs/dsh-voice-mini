import Foundation

// MARK: - Runtime discovery
//
// The host plugin (dsh-voice-mini) writes a small runtime file the widget
// discovers on disk — same seam as aa2246740/dsh-notch.

struct RuntimeFile: Decodable {
  var origin: String
  var token: String
  var pid: Int?
  var writtenAt: Double?
  /// The DSH Desktop shell gates EVERY plugin route behind a per-generation
  /// renderer capability (`x-dsh-desktop-renderer`) whenever ordinary-browser
  /// access is off. The host plugin reads that capability from its own
  /// `desktopBrowserAccess` service and passes it through here, so the pet is
  /// accepted like the Electron renderer is.
  var rendererHeader: RendererHeader?

  struct RendererHeader: Decodable {
    var name: String
    var value: String
  }
}

// MARK: - Wire models
//
// Every field is optional on purpose: the host is being written in parallel and
// a missing key must degrade to "unknown", never to "not connected".

struct PetConfig: Decodable {
  var readReplies: Bool?
  var chimeEnabled: Bool?
  var chimeSound: String?
  var statusEnabled: Bool?
  var backend: String?
  var voice: String?

  /// Used only when the host has not answered yet.
  static let assumed: [String: Bool] = [
    "readReplies": false,
    "chimeEnabled": true,
    "statusEnabled": true,
  ]

  func flag(_ key: String) -> Bool? {
    switch key {
    case "readReplies": return readReplies
    case "chimeEnabled": return chimeEnabled
    case "statusEnabled": return statusEnabled
    default: return nil
    }
  }
}

struct PetUtterance: Decodable {
  var kind: String?
  var text: String?
  var startedAt: Double?
  var at: Double?
  var ms: Double?
  var ok: Bool?
}

struct PetSnapshot: Decodable {
  var ok: Bool?
  var speaking: Bool?
  var current: PetUtterance?
  var queued: Int?
  var attention: String?
  var attentionText: String?
  var last: PetUtterance?
  var recent: [PetUtterance]?
  var config: PetConfig?
  var lastError: String?

  var isSpeaking: Bool { speaking ?? false }
  var queueDepth: Int { queued ?? 0 }
  var alertText: String? {
    let text = attentionText?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (text?.isEmpty == false) ? text : nil
  }
  var lastText: String? {
    let text = last?.text?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (text?.isEmpty == false) ? text : nil
  }
}

// MARK: - Errors

enum PetClientError: LocalizedError {
  case runtimeMissing(String)
  case runtimeUnreadable(String, String)
  case badOrigin(String)
  case http(Int, String)
  case decode(String)
  case transport(String)

  var errorDescription: String? {
    switch self {
    case .runtimeMissing(let path):
      return "runtime file not found at \(path) — is the dsh-voice-mini host running?"
    case .runtimeUnreadable(let path, let reason):
      return "runtime file at \(path) is unusable: \(reason)"
    case .badOrigin(let origin):
      return "runtime file has an unusable origin: \(origin)"
    case .http(let status, let body):
      return "host answered HTTP \(status)\(body.isEmpty ? "" : ": \(body)")"
    case .decode(let reason):
      return "state JSON did not decode: \(reason)"
    case .transport(let message):
      return message
    }
  }
}

// MARK: - Client

/// One short-lived request per poll. The runtime file is re-read every time so a
/// restarted host (new port or token) is picked up without relaunching the pet.
final class PetClient: @unchecked Sendable {
  static let defaultRuntimePath = ".dsh/voice-mini/runtime.json"

  /// `DSH_VOICE_PET_RUNTIME_FILE` wins; otherwise `~/.dsh/voice-mini/runtime.json`.
  static var runtimeFileURL: URL {
    let env = ProcessInfo.processInfo.environment["DSH_VOICE_PET_RUNTIME_FILE"]
    if let env, !env.isEmpty {
      return URL(fileURLWithPath: (env as NSString).expandingTildeInPath)
    }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(defaultRuntimePath)
  }

  private(set) var origin = ""
  private(set) var token = ""
  private(set) var rendererHeader: RuntimeFile.RendererHeader?

  /// Ephemeral: polled state must never be served from a disk cache, and the
  /// widget has no business writing into ~/Library/Caches.
  private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 4
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }()

  var tokenLength: Int { token.count }

  func reloadRuntime() throws {
    let url = Self.runtimeFileURL
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw PetClientError.runtimeMissing(url.path)
    }
    do {
      let data = try Data(contentsOf: url)
      let file = try JSONDecoder().decode(RuntimeFile.self, from: data)
      let trimmed = file.origin.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, URL(string: trimmed) != nil else {
        throw PetClientError.badOrigin(trimmed)
      }
      origin = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
      token = file.token
      rendererHeader = file.rendererHeader
    } catch let error as PetClientError {
      throw error
    } catch {
      throw PetClientError.runtimeUnreadable(url.path, error.localizedDescription)
    }
  }

  /// GET /voice-mini/pet/state — returns the decoded snapshot plus the raw bytes.
  func state() async throws -> (snapshot: PetSnapshot, raw: Data) {
    let data = try await get("/voice-mini/pet/state")
    do {
      return (try JSONDecoder().decode(PetSnapshot.self, from: data), data)
    } catch {
      throw PetClientError.decode(error.localizedDescription)
    }
  }

  /// POST /voice-mini/pet/config — any subset of the config keys.
  func setConfig(_ payload: [String: Bool]) async throws {
    _ = try await post("/voice-mini/pet/config", payload: payload)
  }

  /// POST /voice-mini/pet/test — speak a test utterance.
  func test() async throws {
    _ = try await post("/voice-mini/pet/test", payload: [:])
  }

  /// POST /voice-mini/pet/attention/clear
  func clearAttention() async throws {
    _ = try await post("/voice-mini/pet/attention/clear", payload: [:])
  }

  // MARK: Transport

  private func get(_ path: String) async throws -> Data {
    var request = try makeRequest(path)
    request.httpMethod = "GET"
    return try await send(request)
  }

  private func post(_ path: String, payload: [String: Bool]) async throws -> Data {
    var request = try makeRequest(path)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)
    return try await send(request)
  }

  private func send(_ request: URLRequest) async throws -> Data {
    do {
      let (data, response) = try await session.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard (200..<300).contains(status) else {
        let body = String(data: data.prefix(200), encoding: .utf8)?
          .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw PetClientError.http(status, body)
      }
      return data
    } catch let error as PetClientError {
      throw error
    } catch {
      throw PetClientError.transport(error.localizedDescription)
    }
  }

  private func makeRequest(_ path: String) throws -> URLRequest {
    if origin.isEmpty { try reloadRuntime() }
    guard let url = URL(string: origin + path) else { throw PetClientError.badOrigin(origin) }
    var request = URLRequest(url: url, timeoutInterval: 4)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    // Desktop-shell gate: without this the shell answers 403 "forbidden" on
    // every plugin route while ordinary-browser access is disabled.
    if let rendererHeader {
      request.setValue(rendererHeader.value, forHTTPHeaderField: rendererHeader.name)
    }
    return request
  }
}