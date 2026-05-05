//
//  ChatAPI.swift
//  canopy
//

import Foundation

enum ChatProvider {
    case google(model: String)
    case anthropic(model: String)
    case openai(model: String)

    static let defaultGoogle = ChatProvider.google(model: "gemini-2.5-flash")
    static let defaultAnthropic = ChatProvider.anthropic(model: "claude-sonnet-4-6")
    static let defaultOpenAI = ChatProvider.openai(model: "gpt-4o")

    // "google:gemini-2.0-flash" — used for UserDefaults and Convex storage
    var rawValue: String {
        switch self {
        case .google(let m): return "google:\(m)"
        case .anthropic(let m): return "anthropic:\(m)"
        case .openai(let m): return "openai:\(m)"
        }
    }

    static func from(rawValue: String) -> ChatProvider? {
        let parts = rawValue.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        switch parts[0] {
        case "google": return .google(model: parts[1])
        case "anthropic": return .anthropic(model: parts[1])
        case "openai": return .openai(model: parts[1])
        default: return nil
        }
    }

    // Short label for toolbar badges and menus
    var shortName: String {
        let lookup: [String: String] = [
            "gemini-2.5-flash": "Gemini 2.5 Flash",
            "gemini-2.5-pro": "Gemini 2.5 Pro",
            "gemini-2.0-flash": "Gemini 2.0 Flash",
            "claude-sonnet-4-6": "Sonnet 4.6",
            "claude-opus-4-7": "Opus 4.7",
            "claude-haiku-4-5-20251001": "Haiku 4.5",
            "gpt-4o": "GPT-4o",
            "gpt-4o-mini": "GPT-4o Mini",
        ]
        return lookup[modelName] ?? modelName
    }

    var displayName: String {
        switch self {
        case .google: return "Google · \(shortName)"
        case .anthropic: return "Anthropic · \(shortName)"
        case .openai: return "OpenAI · \(shortName)"
        }
    }

    fileprivate var pathComponent: String {
        switch self {
        case .google: return "/chat/google"
        case .anthropic: return "/chat/anthropic"
        case .openai: return "/chat/openai"
        }
    }

    fileprivate var mcpPathComponent: String {
        switch self {
        case .anthropic: return "/chat/anthropic-mcp"
        default: return pathComponent
        }
    }

    var modelName: String {
        switch self {
        case .google(let m), .anthropic(let m), .openai(let m): return m
        }
    }
}

struct ChatMessage {
    let role: String   // "user" or "assistant"
    let content: String
}

/// Generic streaming chat client that works with all three provider endpoints.
/// All endpoints accept { "message": "...", "model": "...", "history": [...] } and return
/// normalized SSE:  data: {"text":"chunk"} … data: [DONE]
final class ChatAPI {
    // One session shared across all ChatAPI instances.
    // All three providers go through the same Convex domain, so a shared session
    // preserves TLS session tickets across provider switches — no cold handshake
    // cost when the user switches from Google to Anthropic and back.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = true
        config.urlCache = nil
        config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }()

    // Call once at app launch to pre-establish the TLS connection to Convex.
    // Without this the very first request pays ~150ms for the full TLS handshake.
    private static let warmupOnce: Void = {
        guard var c = URLComponents(string: "https://oceanic-opossum-563.convex.site") else { return }
        c.path = "/"
        guard let url = c.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 10
        session.dataTask(with: req) { _, _, _ in }.resume()
    }()

    static func warmUp() { _ = warmupOnce }

    private let endpointURL: URL
    private let modelName: String
    // Non-nil when Anthropic MCP mode is active; sent as `entityId` in the request body.
    private let entityId: String?

    init(baseURL: String, provider: ChatProvider, entityId: String? = nil) {
        let useMCP = entityId != nil
        let path = useMCP ? provider.mcpPathComponent : provider.pathComponent
        self.endpointURL = URL(string: baseURL + path)!
        self.modelName = provider.modelName
        self.entityId = entityId
    }

    /// Streams a chat message through the selected provider endpoint.
    /// Calls `onTextChunk` on the main actor with the accumulated text so far.
    /// Returns the full response when the stream completes.
    func sendMessage(
        _ text: String,
        history: [ChatMessage] = [],
        onTextChunk: @MainActor @Sendable (String) -> Void
    ) async throws -> String {
        var request = URLRequest(url: endpointURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let historyPayload = history.map { ["role": $0.role, "content": $0.content] }
        var body: [String: Any] = ["message": text, "model": modelName, "history": historyPayload]
        if let entityId { body["entityId"] = entityId }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (byteStream, response) = try await Self.session.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "ChatAPI", code: -1,
                         userInfo: [NSLocalizedDescriptionKey: "Invalid HTTP response"])
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            var lines: [String] = []
            for try await line in byteStream.lines { lines.append(line) }
            throw NSError(domain: "ChatAPI", code: httpResponse.statusCode,
                         userInfo: [NSLocalizedDescriptionKey: "API error (\(httpResponse.statusCode)): \(lines.joined(separator: "\n"))"])
        }

        var accumulatedText = ""

        for try await line in byteStream.lines {
            guard line.hasPrefix("data: ") else { continue }
            let jsonStr = String(line.dropFirst(6))
            guard jsonStr != "[DONE]" else { break }

            guard let jsonData = jsonStr.data(using: .utf8),
                  let payload = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let chunk = payload["text"] as? String else { continue }

            accumulatedText += chunk
            let current = accumulatedText
            await onTextChunk(current)
        }

        return accumulatedText
    }
}
