//
//  AudioCaptureEngine.swift
//  canopy
//

import AVFoundation

/// Captures microphone audio and delivers raw AVAudioPCMBuffers via a callback.
/// The tap callback runs on an audio thread — callers must not assume any specific thread.
final class AudioCaptureEngine {
    private let engine = AVAudioEngine()
    private(set) var isRunning = false

    /// Installs a tap on the input node and starts the engine.
    /// `onBuffer` is called on an audio thread for each captured buffer.
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        guard !isRunning else { return }

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            onBuffer(buffer)
        }

        try engine.start()
        isRunning = true
        print("🎙️ AudioCaptureEngine: started (format: \(format.sampleRate)Hz)")
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
