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
    private lazy var voice: ChatVoiceController = ChatVoiceController(ttsClient: ttsClient)
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
        // We always route through the MCP/tool-loop endpoints so that
        // built-in tools (e.g. `take_screenshot`) are available regardless
        // of whether the user has any Composio connections. The Composio
        // tools call short-circuits to an empty list (and gets cached) for
        // users without connections, so the cost is one extra HTTP hop on
        // a 5-minute cadence — fine.
        switch provider {
        case .anthropic, .openai, .google:
            return ConnectorsViewModel.shared.userId
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
        // Power level for the speaking visualizer is now driven by the
        // sentence-chunked playback queue inside ChatVoiceController.
        // Keep the direct TTS hookup too in case anything still calls
        // speakText() — both paths feed the same @Published property.
        ttsClient.onPowerLevel = { [weak self] power in self?.ttsPowerLevel = power }
        voice.onPowerLevel = { [weak self] power in self?.ttsPowerLevel = power }
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

        Analytics.trackUserMessageSent(transcript: messageText)

        loadHistoryFromConvexIfNeeded()

        // Reset history if the session has been idle for 15 minutes
        if let last = lastMessageSentAt, Date().timeIntervalSince(last) >= Self.inactivityInterval {
            conversationHistory = []
        }
        lastMessageSentAt = Date()

        isSending = true
        // Cut off any leftover audio from the previous turn before starting.
        voice.interrupt()
        isSpeaking = true

        let historySnapshot = conversationHistory

        sendTask = Task {
            var fullText = ""
            var streamUsage: ChatUsageSummary?
            do {
                Task {
                    do {
                        let args: [String: ConvexEncodable?] = ["role": "user", "content": messageText]
                        try await convex.mutation("conversations:saveMessage", with: args)
                    } catch {
                        print("❌ saveMessage(user) failed: \(error)")
                    }
                }

                for try await event in chatAPI.sendMessage(messageText, history: historySnapshot) {
                    if Task.isCancelled { break }
                    switch event {
                    case .text(let chunk):
                        fullText += chunk
                        voice.handleTextChunk(fullText)
                    case .usage(let summary):
                        streamUsage = summary
                    case .toolStart(let name, _, let inputJSON):
                        // Flush whatever preamble we have so it plays
                        // DURING the tool call, not after.
                        voice.handleToolStart()
                        if name == "take_screenshot" {
                            handleTakeScreenshotToolStart(inputJSON: inputJSON)
                        }
                    case .toolEnd:
                        voice.handleToolEnd()
                    case .error(let msg, let detail):
                        let detailStr = detail.map { " — \($0)" } ?? ""
                        print("❌ stream error: \(msg)\(detailStr)")
                        Analytics.trackResponseError(error: "\(msg)\(detailStr)")
                    }
                }
                voice.handleStreamEnd()

                if !Task.isCancelled, !fullText.isEmpty {
                    Analytics.trackAIResponseReceived(response: fullText)
                    conversationHistory.append(ChatMessage(role: "user", content: messageText))
                    conversationHistory.append(ChatMessage(role: "assistant", content: fullText))
                    // Keep only the last 10 exchanges (20 messages)
                    if conversationHistory.count > 20 {
                        conversationHistory.removeFirst(conversationHistory.count - 20)
                    }

                    Task {
                        do {
                            let modelForRow = streamUsage?.model.trimmingCharacters(in: .whitespacesAndNewlines)
                            let resolvedModel: String? = (modelForRow?.isEmpty == false)
                                ? modelForRow
                                : chatAPI.requestedModelId
                            var args: [String: ConvexEncodable?] = [
                                "role": "assistant",
                                "content": fullText,
                                "model": resolvedModel,
                            ]
                            if let u = streamUsage {
                                args["tokensIn"] = Double(u.tokensIn)
                                args["tokensOut"] = Double(u.tokensOut)
                            }
                            try await convex.mutation("conversations:saveMessage", with: args)
                        } catch {
                            print("❌ saveMessage(assistant) failed: \(error)")
                        }
                    }
                }

                // Hold the speaking indicator (and treat fn as cancel) until
                // every queued sentence has actually played.
                await voice.awaitPlaybackFinished()
            } catch is CancellationError {
                // cancelled — voice.interrupt() was called by cancel()
            } catch {
                print("❌ CanopyViewModel error: \(error)")
                Analytics.trackResponseError(error: error.localizedDescription)
            }
            isSending = false
            isSpeaking = false
            ttsPowerLevel = 0
        }
    }

    func cancel() {
        sendTask?.cancel()
        sendTask = nil
        screenshotTask?.cancel()
        screenshotTask = nil
        isSending = false
        isSpeaking = false
        ttsPowerLevel = 0
        voice.interrupt()
        ttsClient.stopPlayback()
        GuideOverlayController.shared.dismiss(animated: true)
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
            Analytics.trackPushToTalkStarted()
        } catch {
            print("❌ Failed to start recording: \(error)")
            isRecording = false
        }
    }

    func stopRecording() {
        guard isRecording else { return }

        Analytics.trackPushToTalkReleased()

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

    // MARK: - take_screenshot tool

    private static let screenshotLocateURL = URL(string: "\(convexBaseURL)/screenshot/locate")!

    /// Track the active screenshot task so a second call interrupts the first
    /// (rare, but possible if the model fires the tool twice in one turn).
    private var screenshotTask: Task<Void, Never>?

    /// Fired when the chat stream emits `tool_start` for `take_screenshot`.
    /// Kicks off screen capture + element location out of band — the chat
    /// itself keeps streaming on the backend; we just drive the visual
    /// pointer on the client.
    private func handleTakeScreenshotToolStart(inputJSON: String?) {
        let description = Self.parseTakeScreenshotDescription(inputJSON: inputJSON)
        guard !description.isEmpty else {
            print("⚠️ take_screenshot called with empty/missing description")
            return
        }

        screenshotTask?.cancel()
        screenshotTask = Task { [weak self] in
            await self?.runTakeScreenshot(description: description)
        }
    }

    private static func parseTakeScreenshotDescription(inputJSON: String?) -> String {
        guard let inputJSON,
              let data = inputJSON.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return "" }
        return (dict["description"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func runTakeScreenshot(description: String) async {
        let capture: CanopyScreenCapture
        do {
            capture = try await ScreenCaptureUtility.captureCursorScreen()
        } catch {
            print("❌ take_screenshot: capture failed — \(error.localizedDescription)")
            return
        }

        if Task.isCancelled { return }

        let locateResult: ScreenshotLocateResult
        do {
            locateResult = try await Self.requestScreenshotLocate(
                imageData: capture.imageData,
                imageWidth: capture.imageWidthPixels,
                imageHeight: capture.imageHeightPixels,
                description: description
            )
        } catch {
            print("❌ take_screenshot: locate request failed — \(error.localizedDescription)")
            return
        }

        if Task.isCancelled { return }

        switch locateResult {
        case .miss(let reason):
            print("⚠️ take_screenshot: \(reason)")
        case .found(let imagePoint, let label):
            // Map image-pixel coords (top-left origin) → global AppKit
            // coords (bottom-left origin) on the captured display.
            guard let globalPoint = ScreenCaptureUtility.mapImagePointToGlobalAppKit(
                imagePoint: imagePoint,
                capture: capture
            ) else {
                print("⚠️ take_screenshot: could not map coordinates")
                return
            }
            // Belt-and-suspenders: ensure the global point actually lies
            // inside the display we captured. Out-of-bounds coords from
            // Claude were already clamped server-side, but we re-check here
            // because zero-width/zero-height edge cases produce nonsense.
            guard capture.displayFrame.contains(globalPoint) else {
                print("⚠️ take_screenshot: target out of display bounds — \(globalPoint) not in \(capture.displayFrame)")
                return
            }

            Analytics.trackElementPointed(elementLabel: label)

            GuideOverlayController.shared.showPointing(
                toGlobalAppKit: globalPoint,
                on: capture.displayFrame,
                label: label
            )
        }
    }

    /// POSTs the screenshot to the backend's `/screenshot/locate` endpoint.
    /// All Anthropic calls happen there — we never see the API key on the
    /// client.
    private static func requestScreenshotLocate(
        imageData: Data,
        imageWidth: Int,
        imageHeight: Int,
        description: String
    ) async throws -> ScreenshotLocateResult {
        var request = URLRequest(url: screenshotLocateURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 25

        let payload: [String: Any] = [
            "image": imageData.base64EncodedString(),
            "imageWidth": imageWidth,
            "imageHeight": imageHeight,
            "description": description,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "Canopy.Screenshot", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid response"])
        }
        guard (200...299).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "Canopy.Screenshot", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "Locate failed (HTTP \(http.statusCode)): \(body)"])
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "Canopy.Screenshot", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "Locate response was not JSON"])
        }

        if let found = json["found"] as? Bool, found,
           let xVal = json["x"], let yVal = json["y"] {
            let x = (xVal as? Double) ?? Double(xVal as? Int ?? 0)
            let y = (yVal as? Double) ?? Double(yVal as? Int ?? 0)
            let label = (json["label"] as? String)?.trimmingCharacters(in: .whitespaces)
            return .found(imagePoint: CGPoint(x: x, y: y), label: label?.isEmpty == false ? label : nil)
        }

        let reason = (json["reason"] as? String) ?? "Unknown reason"
        return .miss(reason: reason)
    }
}

private enum ScreenshotLocateResult {
    case found(imagePoint: CGPoint, label: String?)
    case miss(reason: String)
}
