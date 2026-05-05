//
//  SentenceChunker.swift
//  canopy
//
//  Pure logic that buffers streamed text and yields complete sentences as
//  they finalize. Used to drive sentence-grained TTS synthesis: as soon as
//  a sentence terminator arrives, the sentence is sent to ElevenLabs and
//  queued for playback while later sentences are still being generated.
//
//  Sentence-end detection is intentionally simple: split on `.`, `!`, `?`,
//  `\n`, but require at least 8 characters (after trimming) before a
//  sentence is considered complete. This handles the common abbreviation
//  case (e.g. "Mr.") without trying to enumerate every edge case — the
//  system prompt steers the model toward casual short sentences anyway.
//

import Foundation

struct SentenceChunker {
    /// Minimum trimmed length for a candidate sentence to be drained. Keeps
    /// "Mr." from being split off "Mr. Smith said hi." mid-stream.
    static let minSentenceLength = 8
    private static let terminators: Set<Character> = [".", "!", "?", "\n"]

    private var buffer: String = ""

    /// Append text and return any complete sentences extracted from the buffer.
    /// Sentences are returned in source order, trimmed of leading/trailing
    /// whitespace.
    mutating func append(_ text: String) -> [String] {
        buffer += text
        return drainCompleteSentences()
    }

    /// Returns whatever's left in the buffer (trimmed) and empties it.
    /// Use this on `.toolStart` to play the preamble before the tool runs,
    /// and at end-of-stream to play the tail of the final sentence.
    mutating func flush() -> String? {
        let trimmed = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Internals

    private mutating func drainCompleteSentences() -> [String] {
        var results: [String] = []
        var startIdx = buffer.startIndex
        var idx = buffer.startIndex

        while idx < buffer.endIndex {
            let ch = buffer[idx]
            if Self.terminators.contains(ch) {
                let endAfterTerminator = buffer.index(after: idx)
                let candidate = String(buffer[startIdx..<endAfterTerminator])
                let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.count >= Self.minSentenceLength {
                    results.append(trimmed)
                    startIdx = endAfterTerminator
                }
            }
            idx = buffer.index(after: idx)
        }

        if startIdx > buffer.startIndex {
            buffer = String(buffer[startIdx...])
        }
        return results
    }
}
