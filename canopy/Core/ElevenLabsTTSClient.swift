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

    /// Called on MainActor with normalized power 0…1 while TTS is playing.
    var onPowerLevel: ((CGFloat) -> Void)?

    init(proxyURL: String) {
        self.proxyURL = URL(string: proxyURL)!
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: configuration)
    }

    /// Fetches audio from ElevenLabs and returns the raw MP3 bytes without
    /// playing them. Use this when you want to manage playback yourself
    /// (e.g. sentence-chunked queueing through `AudioPlaybackQueue`).
    func synthesize(_ text: String) async throws -> Data {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        let body: [String: Any] = [
            "text": text,
            // Flash v2.5: lowest generation latency (~75ms cited by ElevenLabs, excluding network).
            // Use `eleven_multilingual_v2` when quality beats responsiveness.
            "model_id": "eleven_flash_v2_5",
            // 0…4; higher = faster time-to-first-byte (slightly lower audio fidelity).
            "optimize_streaming_latency": 4,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]
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
        return data
    }

    /// Fetches audio from ElevenLabs, plays it, and awaits until playback finishes.
    /// Fires `onPowerLevel` at ~30 fps while speaking so callers can drive a waveform.
    /// Kept for any non-streaming callers; the streaming chat flow uses
    /// `synthesize(_:)` + `AudioPlaybackQueue` instead.
    func speakText(_ text: String) async throws {
        let data = try await synthesize(text)

        try Task.checkCancellation()

        let player = try AVAudioPlayer(data: data)
        player.isMeteringEnabled = true
        player.delegate = self
        self.audioPlayer = player
        player.play()
        print("🔊 ElevenLabs TTS: playing \(data.count / 1024)KB audio")

        // Poll the meter at ~30 fps until playback ends
        Task { @MainActor [weak self] in
            while self?.audioPlayer?.isPlaying == true {
                self?.audioPlayer?.updateMeters()
                let db = self?.audioPlayer?.averagePower(forChannel: 0) ?? -160
                let linear = pow(10.0, Double(db) / 20.0)
                self?.onPowerLevel?(CGFloat(min(linear * 6, 1.0)))
                try? await Task.sleep(nanoseconds: 33_000_000)
            }
            self?.onPowerLevel?(0)
        }

        // Suspend until delegate or stopPlayback() resumes us
        await withCheckedContinuation { continuation in
            self.playerContinuation = continuation
        }
    }

    var isPlaying: Bool { audioPlayer?.isPlaying ?? false }

    /// Stops playback immediately and unblocks any awaiting `speakText` call.
    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        onPowerLevel?(0)
        playerContinuation?.resume()
        playerContinuation = nil
    }
}

extension ElevenLabsTTSClient: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.audioPlayer = nil
            self?.onPowerLevel?(0)
            self?.playerContinuation?.resume()
            self?.playerContinuation = nil
        }
    }
}
