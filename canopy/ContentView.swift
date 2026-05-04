import SwiftUI
import AppKit

struct ContentView: View {
    @EnvironmentObject var dictation: FnDictationManager
    @State private var isHovered = false

    private var showBadge: Bool { isHovered || !dictation.statusText.isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            if showBadge {
                HStack(spacing: 8) {
                    if dictation.isRecording {
                        Image(systemName: "mic.fill")
                            .foregroundStyle(.red)
                    } else if !dictation.statusText.isEmpty {
                        Image(systemName: "waveform")
                            .foregroundStyle(.white)
                    } else {
                        Image(systemName: "wand.and.rays")
                            .foregroundStyle(.white)
                    }
                    Text(dictation.statusText.isEmpty
                         ? "Click or hold **fn** to start dictating"
                         : dictation.statusText)
                        .foregroundStyle(.white)
                        .font(.system(size: 14, weight: .medium))
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .background(.black, in: Capsule())
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            HStack(spacing: 4) {
                ForEach(0..<7, id: \.self) { _ in
                    Circle()
                        .fill(dictation.isRecording ? Color.red : Color.white.opacity(0.6))
                        .frame(width: 4, height: 4)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.black, in: Capsule())
        }
        .animation(.spring(duration: 0.3), value: isHovered)
        .animation(.spring(duration: 0.2), value: dictation.isRecording)
        .animation(.spring(duration: 0.2), value: dictation.statusText)
        .onHover { hovering in isHovered = hovering }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 16)
        .onAppear { setupWindow() }
    }

    func setupWindow() {
        guard let window = NSApplication.shared.windows.first else { return }

        window.styleMask = [.borderless, .fullSizeContentView]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .floating
        window.hasShadow = false
        window.ignoresMouseEvents = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]

        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouseLocation, $0.frame, false) }) ?? NSScreen.main
        if let screen {
            let frame = screen.frame
            window.setFrame(
                CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 120),
                display: true
            )
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(FnDictationManager())
}
