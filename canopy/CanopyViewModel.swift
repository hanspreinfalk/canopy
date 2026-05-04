//
//  CanopyViewModel.swift
//  canopy
//

import Foundation
import Combine

@MainActor
final class CanopyViewModel: ObservableObject {
    @Published var isEditing = false
    @Published var isSending = false
    @Published var inputText = ""
    @Published var geminiResponse = ""

    private let geminiAPI = GeminiAPI(proxyBaseURL: "https://oceanic-opossum-563.convex.site")
    private let ttsClient = ElevenLabsTTSClient(proxyURL: "https://oceanic-opossum-563.convex.site/tts")
    private var sendTask: Task<Void, Never>?

    func startEditing() {
        isEditing = true
    }

    func stopEditing() {
        isEditing = false
        inputText = ""
    }

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        stopEditing()
        guard !text.isEmpty else { return }

        isSending = true
        geminiResponse = ""

        sendTask = Task {
            do {
                let fullText = try await geminiAPI.sendMessage(text) { [weak self] chunk in
                    self?.geminiResponse = chunk
                }
                isSending = false
                try await ttsClient.speakText(fullText)
            } catch is CancellationError {
                isSending = false
            } catch {
                print("❌ CanopyViewModel error: \(error)")
                isSending = false
            }
            geminiResponse = ""
        }
    }

    func cancel() {
        sendTask?.cancel()
        sendTask = nil
        isSending = false
        geminiResponse = ""
        ttsClient.stopPlayback()
    }
}
