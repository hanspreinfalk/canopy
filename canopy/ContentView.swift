//
//  ContentView.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import SwiftUI
import AppKit
import Combine
import ConvexMobile

struct TaskItem: Hashable, Decodable {
    let _id: String
    let isCompleted: Bool
    let text: String
}

struct ContentView: View {
    @State private var isHovered = false
    @FocusState private var isFocused: Bool
    @StateObject private var vm = CanopyViewModel()
    var dismiss: () -> ()

    // convex test
    @State private var tasks: [TaskItem] = []
    let client = ConvexClient(deploymentUrl: "https://oceanic-opossum-563.convex.cloud")
    func fetchTasks() async {
        do {
            for try await tasks: [TaskItem] in client.subscribe(to: "tasks:get").values {
                self.tasks = tasks
            }
        } catch {}
    }

    private var isActive: Bool { isHovered || vm.isEditing || vm.isSending || vm.isRecording }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(alignment: .center, spacing: 8) {
                if isHovered && !vm.isEditing && !vm.isSending && !vm.isRecording {
                    hintPill
                        .transition(.asymmetric(
                            insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                            removal: .opacity.animation(.easeOut(duration: 0.1))
                        ))
                }
                HStack(alignment: .bottom, spacing: 8) {
                    mainPill
                    if isActive {
                        actionButton
                            .transition(.asymmetric(
                                insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                                removal: .opacity.animation(.easeOut(duration: 0.1))
                            ))
                    }
                }
            }
            .offset(x: isActive ? 20 : 0)
            .onHover { h in
                if !vm.isEditing && !vm.isSending && !vm.isRecording { isHovered = h }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isHovered)
        .animation(.easeInOut(duration: 0.2), value: vm.isEditing)
        .animation(.easeInOut(duration: 0.2), value: vm.isSending)
        .animation(.easeInOut(duration: 0.15), value: vm.isRecording)
    }

    private var mainPill: some View {
        ZStack {
            if vm.isEditing {
                TextField("", text: $vm.inputText)
                    .textFieldStyle(.plain)
                    .foregroundColor(.white)
                    .font(.system(size: 12))
                    .focused($isFocused)
                    .onSubmit { submitMessage() }
                    .onKeyPress(.escape) { vm.stopEditing(); return .handled }
                    .padding(.horizontal, 10)

            } else if vm.isRecording {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 6, height: 6)
                    Text(vm.liveTranscript.isEmpty ? "Listening..." : vm.liveTranscript)
                        .foregroundColor(.white.opacity(0.9))
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .padding(.horizontal, 10)
                .transition(.opacity.animation(.easeIn(duration: 0.1)))

            } else if vm.isSending {
                Text(vm.geminiResponse.isEmpty ? "..." : vm.geminiResponse)
                    .foregroundColor(.white.opacity(0.85))
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .transition(.opacity.animation(.easeIn(duration: 0.15)))

            } else if isHovered {
                Text("· · · · · · · · · ·")
                    .foregroundColor(.white.opacity(0.5))
                    .font(.system(size: 11))
                    .transition(.opacity.animation(.easeIn(duration: 0.15).delay(0.15)))
            }
        }
        .frame(
            width: (vm.isEditing || vm.isSending || vm.isRecording) ? 200 : (isHovered ? 80 : PillConstants.width),
            height: isActive ? 28 : PillConstants.height
        )
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(RoundedRectangle(cornerRadius: isActive ? 14 : PillConstants.cornerRadius))
    }

    private var hintPill: some View {
        HStack(spacing: 0) {
            Text("Click or hold ")
            Text("fn").foregroundColor(.pink).fontWeight(.semibold)
            Text(" to start dictating")
        }
        .foregroundColor(.white)
        .font(.system(size: 12, weight: .regular))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color(red: 0.1, green: 0.1, blue: 0.1))
        .clipShape(Capsule())
    }

    private var actionButton: some View {
        Button {
            if vm.isRecording {
                // fn-up stops recording; button is just visual during recording
            } else if vm.isSending {
                vm.cancel()
                isHovered = false
            } else if vm.isEditing {
                let hasText = !vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if hasText { submitMessage() } else { vm.stopEditing() }
            } else {
                startEditing()
            }
        } label: {
            if vm.isRecording {
                Image(systemName: "mic.fill")
                    .foregroundColor(.red)
                    .font(.system(size: 12))
            } else {
                let icon = vm.isSending ? "xmark" :
                    (vm.isEditing && !vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        ? "arrow.up.circle.fill" : (vm.isEditing ? "xmark" : "pencil")
                Image(systemName: icon)
                    .foregroundColor(.white)
                    .font(.system(size: 12))
            }
        }
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(Circle())
    }

    private func startEditing() {
        vm.startEditing()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            NSApp.windows.first?.makeKey()
            isFocused = true
        }
    }

    private func submitMessage() {
        isFocused = false
        vm.sendMessage()
    }
}

#Preview {
    ContentView() {}
}
