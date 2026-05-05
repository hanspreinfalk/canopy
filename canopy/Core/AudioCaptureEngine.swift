//
//  AudioCaptureEngine.swift
//  canopy
//

import AVFoundation
import CoreFoundation

/// Captures microphone audio and delivers raw AVAudioPCMBuffers.
/// Both callbacks run on an audio thread — callers must not assume main thread.
final class AudioCaptureEngine {
    private var engine = AVAudioEngine()
    private(set) var isRunning = false

    /// - Parameters:
    ///   - onBuffer: Called with each captured buffer (audio thread).
    ///   - onPowerLevel: Called with RMS power in 0…1 (audio thread).
    func start(
        onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
        onPowerLevel: ((CGFloat) -> Void)? = nil
    ) throws {
        guard !isRunning else { return }

        // Fresh engine each time avoids stale thread/state from a previous session
        engine = AVAudioEngine()
        let inputNode = engine.inputNode

        // nil format lets AVAudio match the hardware's native format automatically,
        // avoiding the mismatch crash when the mic runs at a non-default rate (e.g. 24 kHz on Bluetooth)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
            if let onPowerLevel, let channel = buffer.floatChannelData?[0] {
                let frames = Int(buffer.frameLength)
                var sum: Float = 0
                for i in 0..<frames { sum += channel[i] * channel[i] }
                let rms = sqrt(sum / Float(frames))
                onPowerLevel(CGFloat(min(rms * 5, 1.0)))
            }
            onBuffer(buffer)
        }

        try engine.start()
        isRunning = true
        print("🎙️ AudioCaptureEngine: started (\(inputNode.outputFormat(forBus: 0).sampleRate)Hz)")
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
        print("🎙️ AudioCaptureEngine: stopped")
    }

    deinit { stop() }
}
