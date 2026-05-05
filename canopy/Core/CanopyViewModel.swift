//
//  CanopyViewModel.swift
//  canopy
//

import AVFoundation
import Combine
import ConvexMobile
import Foundation
import Speech

private struct RecentMessagesResult: Decodable {
    struct Message: Decodable {
        let role: String
        let content: String
    }
    let messages: [Message]
}

@MainActor
final class CanopyViewModel: ObservableObject {
    // MARK: - Published state

    @Published var isEditing = false
    @Published var isSending = false
    @Published var isRecording = false
    @Published var inputText = ""
    @Published var liveTranscript = ""
    @Published var audioPowerLevel: CGFloat = 0.0
    @Published var isSpeaking = false
    @Published var ttsPowerLevel: CGFloat = 0.0

    // MARK: - Private dependencies

    private static let convexBaseURL = "https://oceanic-opossum-563.convex.site"
    private static let inactivityInterval: TimeInterval = 15 * 60
    private var chatAPI = ChatAPI(
        baseURL: CanopyViewModel.convexBaseURL,
        provider: AIProviderStore.shared.chatProvider,
        entityId: CanopyViewModel.mcpEntityId(for: AIProviderStore.shared.chatProvider)
    )
    private var providerCancellable: AnyCancellable?
    private let ttsClient = ElevenLabsTTSClient(proxyURL: "https://oceanic-opossum-563.convex.site/tts")
    private let transcriptionProvider: any CustomTranscriptionProvider
    private let audioEngine = AudioCaptureEngine()
    private let fnKeyMonitor = FnKeyMonitor()

    private var conversationHistory: [ChatMessage] = []
    private var lastMessageSentAt: Date?
    private var historyLoadCancellable: AnyCancellable?

    private var connectionsCancellable: AnyCancellable?
    private var sendTask: Task<Void, Never>?
    private var activeSession: (any CustomStreamingTranscriptionSession)?
    private var transcriptFallbackTask: Task<Void, Never>?
    private var transcriptDelivered = false

    // MARK: - Helpers

    private static func mcpEntityId(for provider: ChatProvider) -> String? {
        guard ConnectorsViewModel.shared.hasConnections else { return nil }
        switch provider {
        case .anthropic, .openai: return ConnectorsViewModel.shared.userId
        case .google: return nil
        }
    }

    private func rebuildChatAPI() {
        let provider = AIProviderStore.shared.chatProvider
        chatAPI = ChatAPI(
            baseURL: CanopyViewModel.convexBaseURL,
            provider: provider,
            entityId: CanopyViewModel.mcpEntityId(for: provider)
        )
    }

    // MARK: - Init

    init() {
        transcriptionProvider = CustomTranscriptionProviderFactory.makeDefaultProvider()
        setupFnKeyMonitor()
        ttsClient.onPowerLevel = { [weak self] power in self?.ttsPowerLevel = power }
        providerCancellable = AIProviderStore.shared.$chatProvider
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.rebuildChatAPI() }

        connectionsCancellable = ConnectorsViewModel.shared.$connections
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.rebuildChatAPI() }
    }

    private func loadHistoryFromConvexIfNeeded() {
        guard historyLoadCancellable == nil else { return }
        historyLoadCancellable = convex
            .subscribe(to: "conversations:getRecentMessages", with: ["limit": 10.0] as [String: ConvexEncodable?])
            .receive(on: DispatchQueue.main)
            .first()
            .sink(
                receiveCompletion: { _ in },
                receiveValue: { [weak self] (result: RecentMessagesResult) in
                    guard let self else { return }
                    self.conversationHistory = result.messages.map {
                        ChatMessage(role: $0.role, content: $0.content)
                    }
                    if !self.conversationHistory.isEmpty {
                        self.lastMessageSentAt = Date()
                    }
                }
            )
    }

    // MARK: - fn key monitoring

    private func setupFnKeyMonitor() {
        fnKeyMonitor.onFnDown = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.isSending {
                    self.cancel()
                } else {
                    await self.startRecording()
                }
            }
        }
        fnKeyMonitor.onFnUp = { [weak self] in
            Task { @MainActor [weak self] in self?.stopRecording() }
        }
        fnKeyMonitor.start()
    }

    // MARK: - Text input

    func startEditing() { isEditing = true }

    func stopEditing() {
        isEditing = false
        inputText = ""
    }

    // MARK: - Send

    func sendMessage(text overrideText: String? = nil) {
        let messageText: String
        if let overrideText {
            messageText = overrideText
        } else {
            messageText = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
            stopEditing()
        }
        guard !messageText.isEmpty else { return }

        loadHistoryFromConvexIfNeeded()

        // Reset history if the session has been idle for 15 minutes
        if let last = lastMessageSentAt, Date().timeIntervalSince(last) >= Self.inactivityInterval {
            conversationHistory = []
        }
        lastMessageSentAt = Date()

        isSending = true

        let historySnapshot = conversationHistory

        sendTask = Task {
            do {
                Task {
                    do {
                        let args: [String: ConvexEncodable?] = ["role": "user", "content": messageText]
                        try await convex.mutation("conversations:saveMessage", with: args)
                    } catch {
                        print("❌ saveMessage(user) failed: \(error)")
                    }
                }

                let fullText = try await chatAPI.sendMessage(messageText, history: historySnapshot) { _ in }

                conversationHistory.append(ChatMessage(role: "user", content: messageText))
                conversationHistory.append(ChatMessage(role: "assistant", content: fullText))
                // Keep only the last 10 exchanges (20 messages)
                if conversationHistory.count > 20 {
                    conversationHistory.removeFirst(conversationHistory.count - 20)
                }

                Task {
                    do {
                        let args: [String: ConvexEncodable?] = ["role": "assistant", "content": fullText]
                        try await convex.mutation("conversations:saveMessage", with: args)
                    } catch {
                        print("❌ saveMessage(assistant) failed: \(error)")
                    }
                }

                isSpeaking = true
                try await ttsClient.speakText(fullText)
            } catch is CancellationError {
                // cancelled
            } catch {
                print("❌ CanopyViewModel error: \(error)")
            }
            isSending = false
            isSpeaking = false
            ttsPowerLevel = 0
        }
    }

    func cancel() {
        sendTask?.cancel()
        sendTask = nil
        isSending = false
        isSpeaking = false
        ttsPowerLevel = 0
        ttsClient.stopPlayback()
    }

    // MARK: - Recording

    func startRecording() async {
        guard !isRecording && !isSending else { return }

        guard await requestMicrophonePermission() else {
            print("❌ Microphone permission denied")
            return
        }

        if transcriptionProvider.requiresSpeechRecognitionPermission {
            guard await requestSpeechPermission() else {
                print("❌ Speech recognition permission denied")
                return
            }
        }

        isRecording = true
        liveTranscript = ""
        transcriptDelivered = false

        do {
            let session = try await transcriptionProvider.startStreamingSession(
                keyterms: [],
                onTranscriptUpdate: { [weak self] text in
                    Task { @MainActor [weak self] in self?.liveTranscript = text }
                },
                onFinalTranscriptReady: { [weak self] text in
                    Task { @MainActor [weak self] in self?.handleFinalTranscript(text) }
                },
                onError: { error in
                    print("❌ Transcription session error: \(error)")
                }
            )

            // fn may have been released while we were starting up
            guard isRecording else {
                session.cancel()
                return
            }

            activeSession = session

            try audioEngine.start(
                onBuffer: { buffer in session.appendAudioBuffer(buffer) },
                onPowerLevel: { [weak self] power in
                    Task { @MainActor [weak self] in self?.audioPowerLevel = power }
                }
            )
        } catch {
            print("❌ Failed to start recording: \(error)")
            isRecording = false
        }
    }

    func stopRecording() {
        guard isRecording else { return }

        audioEngine.stop()
        isRecording = false
        audioPowerLevel = 0.0

        let session = activeSession
        let fallbackDelay = session?.finalTranscriptFallbackDelaySeconds ?? 2.5

        session?.requestFinalTranscript()

        let capturedTranscript = liveTranscript
        transcriptFallbackTask = Task {
            try? await Task.sleep(for: .seconds(fallbackDelay))
            guard !Task.isCancelled else { return }
            self.handleFinalTranscript(capturedTranscript)
        }
    }

    private func handleFinalTranscript(_ text: String) {
        guard !transcriptDelivered else { return }
        transcriptDelivered = true

        transcriptFallbackTask?.cancel()
        transcriptFallbackTask = nil
        activeSession = nil
        liveTranscript = ""

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        sendMessage(text: trimmed)
    }

    // MARK: - Permission helpers

    private func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
        }
    }

    private func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }
}
