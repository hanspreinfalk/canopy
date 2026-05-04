//
//  GeminiAPI.swift
//  canopy
//

import Foundation

final class GeminiAPI {
    private let proxyURL: URL
    private let session: URLSession

    init(proxyBaseURL: String) {
        self.proxyURL = URL(string: "\(proxyBaseURL)/chat")!
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = true
        config.urlCache = nil
        config.httpCookieStorage = nil
        self.session = URLSession(configuration: config)
    }

    /// Streams a chat message through the Convex /chat proxy (Gemini Flash).
    /// Calls `onTextChunk` on the main actor with the accumulated text so far.
    /// Returns the full response when the stream completes.
    func sendMessage(
        _ text: String,
        onTextChunk: @MainActor @Sendable (String) -> Void
    ) async throws -> String {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120

        let body: [String: Any] = [
            "contents": [
                ["role": "user", "parts": [["text": text]]]
            ],
            "generationConfig": [
                "temperature": 0.7,
                "maxOutputTokens": 1024
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (byteStream, response) = try await session.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "GeminiAPI", code: -1,
                         userInfo: [NSLocalizedDescriptionKey: "Invalid HTTP response"])
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            var lines: [String] = []
            for try await line in byteStream.lines { lines.append(line) }
            throw NSError(domain: "GeminiAPI", code: httpResponse.statusCode,
                         userInfo: [NSLocalizedDescriptionKey: "Gemini error (\(httpResponse.statusCode)): \(lines.joined(separator: "\n"))"])
        }

        var accumulatedText = ""

        for try await line in byteStream.lines {
            guard line.hasPrefix("data: ") else { continue }
            let jsonString = String(line.dropFirst(6))
            guard jsonString != "[DONE]" else { break }

            guard let jsonData = jsonString.data(using: .utf8),
                  let payload = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let candidates = payload["candidates"] as? [[String: Any]],
                  let first = candidates.first,
                  let content = first["content"] as? [String: Any],
                  let parts = content["parts"] as? [[String: Any]],
                  let chunk = parts.first?["text"] as? String else { continue }

            accumulatedText += chunk
            let current = accumulatedText
            await onTextChunk(current)
        }

        print("🤖 Gemini response: \(accumulatedText.count) chars")
        return accumulatedText
    }
}
