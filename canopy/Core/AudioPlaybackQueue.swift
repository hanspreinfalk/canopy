//
//  AudioPlaybackQueue.swift
//  canopy
//
//  A serial FIFO of MP3 clips played back-to-back via AVAudioPlayer.
//
//  Designed for sentence-chunked TTS: each `enqueue(_:)` call adds a clip;
//  whichever clip is at the head of the queue plays through to completion,
//  then the next one starts. Power levels are emitted at ~20Hz while a clip
//  is playing so the existing speaking visualizer keeps animating.
//
//  Errors on a single clip never stall the queue — we log, drop, and move
//  to the next one. `clear()` interrupts the current clip and drops the
//  remaining queue (used by CanopyViewModel.cancel()).
//

import AVFoundation
import Foundation

@MainActor
final class AudioPlaybackQueue: NSObject {
    /// Emitted on the main actor with normalized power 0…1 while a clip is
    /// playing. Curve matches ElevenLabsTTSClient so the visualizer keeps
    /// the same look across the two code paths.
    var onPowerLevel: ((CGFloat) -> Void)?

    var isPlaying: Bool { player?.isPlaying == true }
    /// True only when nothing is currently playing AND the queue is empty.
    /// Use this to detect "all clips have played" — `isPlaying == false` alone
    /// would also be true momentarily between clips.
    var isIdle: Bool { player == nil && queue.isEmpty }

    private var queue: [Data] = []
    private var player: AVAudioPlayer?
    private var meterTask: Task<Void, Never>?

    /// Append a clip. Starts playback immediately if the queue was idle.
    func enqueue(_ audio: Data) {
        queue.append(audio)
        if player == nil {
            playNext()
        }
    }

    /// Stop the current clip and drop everything pending.
    func clear() {
        queue.removeAll()
        stopCurrentPlayer()
    }

    // MARK: - Internals

    private func stopCurrentPlayer() {
        meterTask?.cancel()
        meterTask = nil
        player?.stop()
        player = nil
        onPowerLevel?(0)
    }

    private func playNext() {
        guard !queue.isEmpty else {
            stopCurrentPlayer()
            return
        }

        let data = queue.removeFirst()
        do {
            let p = try AVAudioPlayer(data: data)
            p.isMeteringEnabled = true
            p.delegate = self
            p.prepareToPlay()
            self.player = p
            p.play()
            startMetering()
        } catch {
            print("❌ AudioPlaybackQueue: failed to create player (\(data.count) bytes): \(error)")
            // Don't stall — try the next clip immediately.
            playNext()
        }
    }

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { @MainActor [weak self] in
            // ~20Hz polling. Matches the user-visible cadence in
            // ElevenLabsTTSClient closely enough that there's no perceptible
            // change in the visualizer's smoothness.
            while !Task.isCancelled {
                guard let self, let p = self.player, p.isPlaying else { break }
                p.updateMeters()
                let db = p.averagePower(forChannel: 0)
                let linear = pow(10.0, Double(db) / 20.0)
                self.onPowerLevel?(CGFloat(min(linear * 6, 1.0)))
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }
}

extension AudioPlaybackQueue: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.meterTask?.cancel()
            self.meterTask = nil
            self.player = nil
            self.onPowerLevel?(0)
            self.playNext()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            print("❌ AudioPlaybackQueue: decode error: \(error?.localizedDescription ?? "unknown")")
            guard let self else { return }
            self.meterTask?.cancel()
            self.meterTask = nil
            self.player = nil
            self.onPowerLevel?(0)
            self.playNext()
        }
    }
}
