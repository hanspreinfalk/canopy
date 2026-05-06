//
//  ChatVoiceController.swift
//  canopy
//
//  Bridges the streaming chat event flow to sentence-chunked TTS playback.
//
//  Flow:
//    - `.text` events arrive (delta strings). The view model accumulates and
//      passes the running accumulated string here. We diff against what we've
//      already observed, append the new portion to the chunker, and fire TTS
//      synthesis for any complete sentences that fall out.
//    - `.toolStart` events flush whatever's in the buffer so the model's
//      preamble ("lemme peek at your calendar") gets spoken DURING the tool
//      call instead of after it.
//    - End-of-stream flushes the tail.
//
//  Ordering: TTS network calls have variable latency, so sentence 2 may
//  finish synthesizing before sentence 1. We synthesize concurrently but
//  enqueue serially: each task awaits the previous task's enqueue before
//  pushing its own audio to the playback queue.
//

import Foundation

@MainActor
final class ChatVoiceController {
    /// Power level forwarded from the underlying playback queue.
    var onPowerLevel: ((CGFloat) -> Void)? {
        get { audioQueue.onPowerLevel }
        set { audioQueue.onPowerLevel = newValue }
    }

    var isPlaying: Bool { audioQueue.isPlaying }

    private let ttsClient: ElevenLabsTTSClient
    private let audioQueue = AudioPlaybackQueue()
    private var sentenceChunker = SentenceChunker()

    /// All in-flight synthesis tasks, retained so we can cancel them en masse.
    private var synthesisTasks: [Task<Void, Never>] = []
    /// The most recently scheduled task. Each new synthesis task awaits this
    /// before calling `audioQueue.enqueue(_:)`, which is what guarantees
    /// source-order playback regardless of synthesis completion order.
    private var lastEnqueueTask: Task<Void, Never>?

    /// What the chunker has already seen, used to compute deltas against
    /// the accumulated string the caller passes in.
    private var observedAccumulated: String = ""

    init(ttsClient: ElevenLabsTTSClient) {
        self.ttsClient = ttsClient
    }

    // MARK: - Event handling

    /// Called for each `.text` event. The argument is the running accumulated
    /// assistant text; we diff against what we've already observed.
    func handleTextChunk(_ accumulated: String) {
        let delta: String
        if accumulated.hasPrefix(observedAccumulated) {
            delta = String(accumulated.dropFirst(observedAccumulated.count))
        } else {
            // Provider rewrote earlier text (rare with streaming chunk APIs,
            // but possible). Treat the whole new string as fresh — we'll
            // re-synthesize from scratch. The audio queue is still in source
            // order; at worst the user hears a duplicate.
            delta = accumulated
            sentenceChunker = SentenceChunker()
        }
        observedAccumulated = accumulated

        guard !delta.isEmpty else { return }
        for sentence in sentenceChunker.append(delta) {
            synthesizeAndEnqueue(sentence)
        }
    }

    /// Called on `.toolStart`. Flushes the buffer so the model's preamble
    /// gets spoken while the tool runs.
    func handleToolStart() {
        if let pending = sentenceChunker.flush() {
            synthesizeAndEnqueue(pending)
        }
    }

    /// Called on `.toolEnd`. No-op today; here for future tool-indicator UI.
    func handleToolEnd() {}

    /// Called when the chat stream completes successfully. Flushes any
    /// trailing partial sentence so the very last words don't get dropped.
    func handleStreamEnd() {
        if let tail = sentenceChunker.flush() {
            synthesizeAndEnqueue(tail)
        }
    }

    /// Awaits all pending synthesis to finish enqueuing and then waits for
    /// the audio queue to fully drain. Use after `handleStreamEnd()` to
    /// know when every sentence has finished playing.
    func awaitPlaybackFinished() async {
        // Wait for the most recently scheduled synthesis task to complete its
        // enqueue (or fail). Because each task awaits its predecessor, this
        // transitively waits on every prior task too.
        await lastEnqueueTask?.value
        while !audioQueue.isIdle {
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    /// Cancels in-flight synthesis, clears queued and currently-playing
    /// audio, and resets the chunker. Called from `CanopyViewModel.cancel()`
    /// and at the start of each new send.
    func interrupt() {
        for task in synthesisTasks { task.cancel() }
        synthesisTasks.removeAll()
        lastEnqueueTask = nil
        audioQueue.clear()
        sentenceChunker = SentenceChunker()
        observedAccumulated = ""
    }

    // MARK: - Internals

    private func synthesizeAndEnqueue(_ sentence: String) {
        let trimmed = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let previousTask = lastEnqueueTask
        let task = Task { [weak self] in
            guard let self else { return }
            let audio: Data
            do {
                audio = try await self.ttsClient.synthesize(trimmed)
            } catch is CancellationError {
                return
            } catch {
                print("❌ TTS synthesis failed for: \(trimmed.prefix(40))… — \(error)")
                Analytics.trackTTSError(error: error.localizedDescription)
                return
            }

            // Wait for the prior sentence to be enqueued before us, so the
            // audio queue stays in source order even if our synthesis
            // returned faster than theirs.
            await previousTask?.value
            if Task.isCancelled { return }
            self.audioQueue.enqueue(audio)
        }
        lastEnqueueTask = task
        synthesisTasks.append(task)
    }
}
