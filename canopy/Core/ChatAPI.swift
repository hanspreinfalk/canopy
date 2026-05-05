// //
// //  ChatAPI.swift
// //  canopy
// //

// import Foundation

// enum ChatProvider {
//     case google(model: String)
//     case anthropic(model: String)
//     case openai(model: String)

//     static let defaultGoogle = ChatProvider.google(model: "gemini-2.5-flash")
//     static let defaultAnthropic = ChatProvider.anthropic(model: "claude-sonnet-4-6")
//     static let defaultOpenAI = ChatProvider.openai(model: "gpt-4o")

//     // "google:gemini-2.0-flash" — used for UserDefaults and Convex storage
//     var rawValue: String {
//         switch self {
//         case .google(let m): return "google:\(m)"
//         case .anthropic(let m): return "anthropic:\(m)"
//         case .openai(let m): return "openai:\(m)"
//         }
//     }

//     static func from(rawValue: String) -> ChatProvider? {
//         let parts = rawValue.split(separator: ":", maxSplits: 1).map(String.init)
//         guard parts.count == 2 else { return nil }
//         switch parts[0] {
//         case "google": return .google(model: parts[1])
//         case "anthropic": return .anthropic(model: parts[1])
//         case "openai": return .openai(model: parts[1])
//         default: return nil
//         }
//     }

//     // Short label for toolbar badges and menus
//     var shortName: String {
//         let lookup: [String: String] = [
//             "gemini-2.5-flash": "Gemini 2.5 Flash",
//             "gemini-2.5-pro": "Gemini 2.5 Pro",
//             "gemini-2.0-flash": "Gemini 2.0 Flash",
//             "claude-sonnet-4-6": "Sonnet 4.6",
//             "claude-opus-4-7": "Opus 4.7",
//             "claude-haiku-4-5-20251001": "Haiku 4.5",
//             "gpt-4o": "GPT-4o",
//             "gpt-4o-mini": "GPT-4o Mini",
//         ]
//         return lookup[modelName] ?? modelName
//     }

//     var displayName: String {
//         switch self {
//         case .google: return "Google · \(shortName)"
//         case .anthropic: return "Anthropic · \(shortName)"
//         case .openai: return "OpenAI · \(shortName)"
//         }
//     }

//     fileprivate var pathComponent: String {
//         switch self {
//         case .google: return "/chat/google"
//         case .anthropic: return "/chat/anthropic"
//         case .openai: return "/chat/openai"
//         }
//     }

//     fileprivate var mcpPathComponent: String {
//         switch self {
//         case .anthropic: return "/chat/anthropic-mcp"
//         case .openai:    return "/chat/openai-tools"
//         case .google:    return pathComponent
//         }
//     }

//     var modelName: String {
//         switch self {
//         case .google(let m), .anthropic(let m), .openai(let m): return m
//         }
//     }
// }

// struct ChatMessage {
//     let role: String   // "user" or "assistant"
//     let content: String
// }

// /// Generic streaming chat client that works with all three provider endpoints.
// /// All endpoints accept { "message": "...", "model": "...", "history": [...] } and return
// /// normalized SSE:  data: {"text":"chunk"} … data: [DONE]
// final class ChatAPI {
//     // One session shared across all ChatAPI instances.
//     // All three providers go through the same Convex domain, so a shared session
//     // preserves TLS session tickets across provider switches — no cold handshake
//     // cost when the user switches from Google to Anthropic and back.
//     private static let session: URLSession = {
//         let config = URLSessionConfiguration.default
//         config.timeoutIntervalForRequest = 120
//         config.timeoutIntervalForResource = 300
//         config.waitsForConnectivity = true
//         config.urlCache = nil
//         config.httpCookieStorage = nil
//         return URLSession(configuration: config)
//     }()

//     // Call once at app launch to pre-establish the TLS connection to Convex.
//     // Without this the very first request pays ~150ms for the full TLS handshake.
//     private static let warmupOnce: Void = {
//         guard var c = URLComponents(string: "https://oceanic-opossum-563.convex.site") else { return }
//         c.path = "/"
//         guard let url = c.url else { return }
//         var req = URLRequest(url: url)
//         req.httpMethod = "HEAD"
//         req.timeoutInterval = 10
//         session.dataTask(with: req) { _, _, _ in }.resume()
//     }()

//     static func warmUp() { _ = warmupOnce }

//     private let endpointURL: URL
//     private let modelName: String
//     // Non-nil when Anthropic MCP mode is active; sent as `entityId` in the request body.
//     private let entityId: String?

//     init(baseURL: String, provider: ChatProvider, entityId: String? = nil) {
//         let useMCP = entityId != nil
//         let path = useMCP ? provider.mcpPathComponent : provider.pathComponent
//         self.endpointURL = URL(string: baseURL + path)!
//         self.modelName = provider.modelName
//         self.entityId = entityId
//     }

//     /// Streams a chat message through the selected provider endpoint.
//     /// Calls `onTextChunk` on the main actor with the accumulated text so far.
//     /// Returns the full response when the stream completes.
//     func sendMessage(
//         _ text: String,
//         history: [ChatMessage] = [],
//         onTextChunk: @MainActor @Sendable (String) -> Void
//     ) async throws -> String {
//         var request = URLRequest(url: endpointURL)
//         request.httpMethod = "POST"
//         request.setValue("application/json", forHTTPHeaderField: "Content-Type")

//         let historyPayload = history.map { ["role": $0.role, "content": $0.content] }
//         var body: [String: Any] = ["message": text, "model": modelName, "history": historyPayload]
//         if let entityId { body["entityId"] = entityId }
//         request.httpBody = try JSONSerialization.data(withJSONObject: body)

//         let (byteStream, response) = try await Self.session.bytes(for: request)

//         guard let httpResponse = response as? HTTPURLResponse else {
//             throw NSError(domain: "ChatAPI", code: -1,
//                          userInfo: [NSLocalizedDescriptionKey: "Invalid HTTP response"])
//         }

//         guard (200...299).contains(httpResponse.statusCode) else {
//             var lines: [String] = []
//             for try await line in byteStream.lines { lines.append(line) }
//             throw NSError(domain: "ChatAPI", code: httpResponse.statusCode,
//                          userInfo: [NSLocalizedDescriptionKey: "API error (\(httpResponse.statusCode)): \(lines.joined(separator: "\n"))"])
//         }

//         var accumulatedText = ""

//         for try await line in byteStream.lines {
//             guard line.hasPrefix("data: ") else { continue }
//             let jsonStr = String(line.dropFirst(6))
//             guard jsonStr != "[DONE]" else { break }

//             guard let jsonData = jsonStr.data(using: .utf8),
//                   let payload = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
//                   let chunk = payload["text"] as? String else { continue }

//             accumulatedText += chunk
//             let current = accumulatedText
//             await onTextChunk(current)
//         }

//         return accumulatedText
//     }
// }





//
//  ChatAPI.swift
//  canopy
//
//  Streaming chat client for the Convex backend.
//
//  Why this exists in its current shape:
//  - URLSession.bytes(for:).lines buffers SSE chunks on iOS until enough bytes
//    accumulate to yield a line, which makes streaming feel bundled. We use a
//    URLSessionDataDelegate instead and parse SSE byte-by-byte ourselves.
//  - The backend emits more than just text: tool_start, tool_end, and error
//    events. Callers should be able to react to all of them.
//

import Foundation

// MARK: - Provider

enum ChatProvider {
    case google(model: String)
    case anthropic(model: String)
    case openai(model: String)

    static let defaultGoogle = ChatProvider.google(model: "gemini-2.5-flash")
    static let defaultAnthropic = ChatProvider.anthropic(model: "claude-sonnet-4-6")
    static let defaultOpenAI = ChatProvider.openai(model: "gpt-4o")

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
        case .google: return "/chat/google-mcp"
        case .anthropic: return "/chat/anthropic-mcp"
        case .openai: return "/chat/openai-tools"
        }
    }

    var modelName: String {
        switch self {
        case .google(let m), .anthropic(let m), .openai(let m): return m
        }
    }
}

// MARK: - Public types

struct ChatMessage: Sendable {
    let role: String   // "user" or "assistant"
    let content: String
}

/// One event in a streaming chat response.
/// The backend emits these as SSE; the order matters for UI rendering.
enum ChatStreamEvent: Sendable {
    /// Incremental text chunk. Append to the running message buffer.
    case text(String)
    /// The agent is about to invoke a tool. Whatever text arrived before this
    /// is the preamble ("lemme peek at your calendar"); show a spinner now.
    case toolStart(name: String, id: String?)
    /// Tool finished. Subsequent `text` events are the post-tool answer.
    case toolEnd(name: String, id: String?, ok: Bool)
    /// Server-reported error during the stream. The connection ends after this.
    case error(message: String, detail: String?)
}

enum ChatAPIError: Error, LocalizedError {
    case invalidResponse
    case httpError(status: Int, body: String)
    case streamFailed(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let status, let body):
            return "HTTP \(status): \(body)"
        case .streamFailed(let err):
            return "Stream failed: \(err.localizedDescription)"
        }
    }
}

// MARK: - SSE byte streamer
//
// Bridges URLSessionDataDelegate's didReceive(data:) callback into an
// AsyncStream<Data> that yields raw bytes the moment they arrive from the
// network — no internal buffering. This is the core fix for the SSE bundling
// problem that .bytes(for:).lines causes.

private final class SSEStreamer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // Yielded with raw bytes as they arrive from the network.
    let dataStream: AsyncStream<Data>
    private let dataContinuation: AsyncStream<Data>.Continuation

    // Resolved once with the response headers (status, etc.) so the caller
    // can check for non-2xx without waiting for the body to finish.
    private var responseContinuation: CheckedContinuation<HTTPURLResponse, Error>?
    private let responseLock = NSLock()

    private(set) var task: URLSessionDataTask?
    private var didReceiveResponse = false

    override init() {
        var cont: AsyncStream<Data>.Continuation!
        self.dataStream = AsyncStream<Data>(bufferingPolicy: .unbounded) { c in cont = c }
        self.dataContinuation = cont
        super.init()
    }

    /// Returns the HTTPURLResponse once headers arrive. Throws if the request
    /// failed before headers (e.g. DNS, connection refused).
    func awaitResponse() async throws -> HTTPURLResponse {
        try await withCheckedThrowingContinuation { cont in
            responseLock.lock()
            defer { responseLock.unlock() }
            self.responseContinuation = cont
        }
    }

    func attach(task: URLSessionDataTask) {
        self.task = task
    }

    func cancel() {
        task?.cancel()
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        defer { completionHandler(.allow) }
        guard let http = response as? HTTPURLResponse else { return }
        responseLock.lock()
        let cont = responseContinuation
        responseContinuation = nil
        didReceiveResponse = true
        responseLock.unlock()
        cont?.resume(returning: http)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // Critical: yield immediately. No accumulation, no batching.
        dataContinuation.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // Surface pre-headers errors to whoever's awaiting the response.
        if let error {
            responseLock.lock()
            let cont = responseContinuation
            responseContinuation = nil
            let received = didReceiveResponse
            responseLock.unlock()
            if !received { cont?.resume(throwing: error) }
        }
        dataContinuation.finish()
    }
}

// MARK: - SSE event parser
//
// Splits a stream of arbitrary byte chunks into SSE events on \n\n boundaries.
// Each event is a string; the caller decides how to parse `data: ...` lines
// out of it. Designed to handle byte boundaries that fall mid-event.

private struct SSEParser {
    private var buffer = Data()
    private static let separator = Data([0x0a, 0x0a]) // \n\n

    /// Append new bytes and return any complete events found.
    mutating func feed(_ chunk: Data) -> [String] {
        buffer.append(chunk)
        var events: [String] = []

        while let range = buffer.range(of: Self.separator) {
            let eventBytes = buffer.subdata(in: 0..<range.lowerBound)
            buffer.removeSubrange(0..<range.upperBound)
            if let str = String(data: eventBytes, encoding: .utf8) {
                events.append(str)
            }
        }
        return events
    }
}

// MARK: - ChatAPI

final class ChatAPI {
    // Shared session so TLS handshakes are reused across requests and providers.
    // We use a delegateQueue for SSE streaming; each request spins up its own
    // delegate but they all share the underlying connection pool.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = true
        config.urlCache = nil
        config.httpCookieStorage = nil
        // Keep connections alive for follow-up messages in the same chat.
        config.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: config)
    }()

    // Pre-warm the TLS session at app launch so the first message doesn't
    // pay the ~150ms handshake cost. Idempotent.
    private static let warmupOnce: Void = {
        guard let url = URL(string: "https://oceanic-opossum-563.convex.site/") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 10
        session.dataTask(with: req) { _, _, _ in }.resume()
    }()

    static func warmUp() { _ = warmupOnce }

    private let endpointURL: URL
    private let modelName: String
    private let entityId: String?

    /// - Parameters:
    ///   - baseURL: e.g. "https://oceanic-opossum-563.convex.site"
    ///   - provider: which model + provider to call.
    ///   - entityId: when non-nil, routes to the MCP variant of the endpoint
    ///     and forwards entityId as the user's Composio identity.
    init(baseURL: String, provider: ChatProvider, entityId: String? = nil) {
        let useMCP = entityId != nil
        let path = useMCP ? provider.mcpPathComponent : provider.pathComponent
        guard let url = URL(string: baseURL + path) else {
            fatalError("ChatAPI: invalid baseURL '\(baseURL)' + path '\(path)'")
        }
        self.endpointURL = url
        self.modelName = provider.modelName
        self.entityId = entityId
    }

    /// Streams a chat message and yields events as they arrive. Caller must
    /// iterate with `for try await event in stream { ... }`.
    ///
    /// The stream finishes when the backend sends `[DONE]` or the connection
    /// closes. Errors from the backend arrive as `.error(...)` events; HTTP
    /// errors (non-2xx) throw `ChatAPIError.httpError`.
    func sendMessage(
        _ text: String,
        history: [ChatMessage] = []
    ) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let (stream, continuation) = AsyncThrowingStream<ChatStreamEvent, Error>.makeStream()

        let task = Task { [weak self] in
            guard let self else {
                continuation.finish()
                return
            }
            do {
                try await self.runStream(
                    text: text,
                    history: history,
                    yield: { event in continuation.yield(event) }
                )
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    /// Convenience wrapper for callers that only care about accumulated text.
    /// Returns the final assembled text. Tool events are silently passed
    /// through to `onTool` if provided.
    @discardableResult
    func sendMessage(
        _ text: String,
        history: [ChatMessage] = [],
        onTextChunk: @MainActor @Sendable (String) -> Void,
        onTool: (@MainActor @Sendable (ChatStreamEvent) -> Void)? = nil
    ) async throws -> String {
        var accumulated = ""
        for try await event in sendMessage(text, history: history) {
            switch event {
            case .text(let chunk):
                accumulated += chunk
                let snapshot = accumulated
                await onTextChunk(snapshot)
            case .toolStart, .toolEnd:
                if let onTool { await onTool(event) }
            case .error(let msg, let detail):
                throw ChatAPIError.httpError(
                    status: -1,
                    body: detail.map { "\(msg): \($0)" } ?? msg
                )
            }
        }
        return accumulated
    }

    // MARK: - Internals

    private func runStream(
        text: String,
        history: [ChatMessage],
        yield: @Sendable (ChatStreamEvent) -> Void
    ) async throws {
        var request = URLRequest(url: endpointURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Hint to any intermediate proxy not to buffer or transform the stream.
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let historyPayload = history.map { ["role": $0.role, "content": $0.content] }
        var body: [String: Any] = [
            "message": text,
            "model": modelName,
            "history": historyPayload,
        ]
        if let entityId { body["entityId"] = entityId }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let streamer = SSEStreamer()
        // Per-request session that uses the same config but our streaming
        // delegate. URLSession requires a delegate at construction, so we
        // can't reuse the static session for delegate-driven requests.
        let session = URLSession(
            configuration: Self.session.configuration,
            delegate: streamer,
            delegateQueue: nil
        )
        defer { session.finishTasksAndInvalidate() }

        let task = session.dataTask(with: request)
        streamer.attach(task: task)
        task.resume()

        // Wait for headers so we can check the status code before consuming the body.
        let response = try await streamer.awaitResponse()
        guard (200...299).contains(response.statusCode) else {
            // Drain the body for the error message — capped to avoid OOM on
            // a backend that decides to send back a megabyte of HTML.
            var errorBytes = Data()
            for await chunk in streamer.dataStream {
                errorBytes.append(chunk)
                if errorBytes.count > 16_384 { break }
            }
            let bodyStr = String(data: errorBytes, encoding: .utf8) ?? ""
            throw ChatAPIError.httpError(status: response.statusCode, body: bodyStr)
        }

        var parser = SSEParser()

        for await chunk in streamer.dataStream {
            // Cooperative cancellation — bail out if the consuming Task got cancelled.
            if Task.isCancelled {
                streamer.cancel()
                break
            }

            let events = parser.feed(chunk)
            for eventStr in events {
                if let parsed = Self.parseSSEEvent(eventStr) {
                    switch parsed {
                    case .done:
                        return
                    case .event(let event):
                        yield(event)
                    }
                }
            }
        }
    }

    // MARK: - SSE event parsing

    private enum ParsedSSE {
        case done
        case event(ChatStreamEvent)
    }

    /// Parses one SSE event block (text between `\n\n` boundaries).
    /// Returns nil for blocks that aren't recognized (keepalives, comments).
    private static func parseSSEEvent(_ block: String) -> ParsedSSE? {
        // Each block can have multiple lines; find the data: line.
        for rawLine in block.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            guard line.hasPrefix("data: ") else { continue }
            let payload = String(line.dropFirst(6))

            if payload == "[DONE]" {
                return .done
            }

            guard let data = payload.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            if let chunk = json["text"] as? String {
                return .event(.text(chunk))
            }
            if let toolStart = json["tool_start"] as? [String: Any],
               let name = toolStart["name"] as? String {
                let id = toolStart["id"] as? String
                return .event(.toolStart(name: name, id: id))
            }
            if let toolEnd = json["tool_end"] as? [String: Any],
               let name = toolEnd["name"] as? String {
                let id = toolEnd["id"] as? String
                let ok = (toolEnd["ok"] as? Bool) ?? true
                return .event(.toolEnd(name: name, id: id, ok: ok))
            }
            if let errorMsg = json["error"] as? String {
                let detail = json["detail"] as? String
                return .event(.error(message: errorMsg, detail: detail))
            }
        }
        return nil
    }
}
