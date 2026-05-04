//
//  ElevenLabsTTSClient.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import AVFoundation
import Foundation

@MainActor
final class ElevenLabsTTSClient: NSObject {
    private let proxyURL: URL
    private let session: URLSession
    private var audioPlayer: AVAudioPlayer?
    private var playerContinuation: CheckedContinuation<Void, Never>?

    init(proxyURL: String) {
        self.proxyURL = URL(string: proxyURL)!
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: configuration)
    }

    /// Fetches audio from ElevenLabs and plays it, **awaiting until playback finishes**.
    /// Call `stopPlayback()` or cancel the enclosing Task to interrupt early.
    func speakText(_ text: String) async throws {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "text": text,
            "model_id": "eleven_flash_v2_5",
            "voice_settings": [
                "stability": 0.5,
                "similarity_boost": 0.75
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "ElevenLabsTTS", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw NSError(domain: "ElevenLabsTTS", code: httpResponse.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "TTS API error (\(httpResponse.statusCode)): \(errorBody)"])
        }

        try Task.checkCancellation()

        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        self.audioPlayer = player
        player.play()
        print("🔊 ElevenLabs TTS: playing \(data.count / 1024)KB audio")

        // Suspend until the delegate fires (playback done) or stopPlayback() is called
        await withCheckedContinuation { continuation in
            self.playerContinuation = continuation
        }
    }

    var isPlaying: Bool { audioPlayer?.isPlaying ?? false }

    /// Stops playback immediately and unblocks any awaiting `speakText` call.
    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        playerContinuation?.resume()
        playerContinuation = nil
    }
}

extension ElevenLabsTTSClient: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.audioPlayer = nil
            self?.playerContinuation?.resume()
            self?.playerContinuation = nil
        }
    }
}
