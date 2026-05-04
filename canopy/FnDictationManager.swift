import Foundation
import Combine
import AVFoundation
import Speech
import AppKit

@MainActor
final class FnDictationManager: ObservableObject {
    // Explicit nonisolated publisher avoids the MainActor-isolation conflict with ObservableObject
    nonisolated let objectWillChange = ObservableObjectPublisher()

    @Published var isRecording = false
    @Published var statusText = ""

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var tapInstalled = false

    nonisolated(unsafe) private var globalMonitor: Any?
    nonisolated(unsafe) private var localMonitor: Any?
    private var prevFrontApp: NSRunningApplication?

    init() {
        SFSpeechRecognizer.requestAuthorization { _ in }
        setupMonitors()
    }

    deinit {
        if let m = globalMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
    }

    private func setupMonitors() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlags(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlags(event)
            return event
        }
    }

    private func handleFlags(_ event: NSEvent) {
        let fnDown = event.modifierFlags.contains(.function)
        if fnDown, !isRecording {
            prevFrontApp = NSWorkspace.shared.frontmostApplication
            startRecording()
        } else if !fnDown, isRecording {
            stopAndTranscribe()
        }
    }

    private func startRecording() {
        guard let recognizer = speechRecognizer, recognizer.isAvailable else { return }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        recognitionRequest = request

        recognitionTask = recognizer.recognitionTask(with: request, resultHandler: makeResultHandler())

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        installAudioTap(on: inputNode, format: format, request: request)
        tapInstalled = true

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            statusText = "Listening..."
        } catch {
            reset()
        }
    }

    // nonisolated so the returned closure is not @MainActor — AVFoundation calls it on a background thread
    private nonisolated func makeResultHandler() -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak self] result, error in
            guard result?.isFinal == true || error != nil else { return }
            let text = (result?.isFinal == true) ? result?.bestTranscription.formattedString : nil
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let text, !text.isEmpty {
                    pasteText(text)
                } else {
                    reset()
                }
            }
        }
    }

    // nonisolated so the tap block is not @MainActor — AVAudioEngine calls it on the audio thread
    private nonisolated func installAudioTap(on node: AVAudioInputNode, format: AVAudioFormat, request: SFSpeechAudioBufferRecognitionRequest) {
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private func stopAndTranscribe() {
        audioEngine.stop()
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        recognitionRequest?.endAudio()
        isRecording = false
        statusText = "Transcribing..."
    }

    private func reset() {
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false
        statusText = ""
    }

    private func pasteText(_ text: String) {
        let pb = NSPasteboard.general
        let saved = pb.string(forType: .string)

        pb.clearContents()
        pb.setString(text, forType: .string)

        prevFrontApp?.activate()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [saved] in
            let src = CGEventSource(stateID: .hidSystemState)
            let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true)
            let up   = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false)
            down?.flags = .maskCommand
            up?.flags   = .maskCommand
            down?.post(tap: .cgAnnotatedSessionEventTap)
            up?.post(tap: .cgAnnotatedSessionEventTap)

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [saved] in
                pb.clearContents()
                if let saved { pb.setString(saved, forType: .string) }
            }
        }

        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        statusText = ""
    }
}
