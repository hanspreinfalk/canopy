//
//  ContentView.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import SwiftUI
import AppKit

struct ContentView: View {
    @State private var isHovered = false
    @State private var isEditing = false
    @State private var inputText = ""
    @FocusState private var isFocused: Bool
    var dismiss: () -> ()

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(alignment: .center, spacing: 8) {
                if isHovered && !isEditing {
                    hintPill
                        .transition(.asymmetric(
                            insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                            removal: .opacity.animation(.easeOut(duration: 0.1))
                        ))
                }
                HStack(alignment: .bottom, spacing: 8) {
                    mainPill
                    if isHovered {
                        actionButton
                            .transition(.asymmetric(
                                insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                                removal: .opacity.animation(.easeOut(duration: 0.1))
                            ))
                    }
                }
            }
            .offset(x: isHovered ? 20 : 0)
            .onHover { h in
                if !isEditing { isHovered = h }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isHovered)
        .animation(.easeInOut(duration: 0.2), value: isEditing)
    }

    private var mainPill: some View {
        ZStack {
            if isEditing {
                TextField("", text: $inputText)
                    .textFieldStyle(.plain)
                    .foregroundColor(.white)
                    .font(.system(size: 12))
                    .focused($isFocused)
                    .onSubmit { stopEditing() }
                    .onKeyPress(.escape) { stopEditing(); return .handled }
                    .padding(.horizontal, 10)
            } else if isHovered {
                Text("· · · · · · · · · ·")
                    .foregroundColor(.white.opacity(0.5))
                    .font(.system(size: 11))
                    .transition(.opacity.animation(.easeIn(duration: 0.15).delay(0.15)))
            }
        }
        .frame(
            width: isEditing ? 200 : (isHovered ? 80 : PillConstants.width),
            height: (isHovered || isEditing) ? 28 : PillConstants.height
        )
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(RoundedRectangle(cornerRadius: (isHovered || isEditing) ? 14 : PillConstants.cornerRadius))
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
            if isEditing {
                stopEditing()
            } else {
                startEditing()
            }
        } label: {
            Image(systemName: isEditing ? "xmark" : "wand.and.rays")
                .foregroundColor(.white)
                .font(.system(size: 12))
        }
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(Circle())
    }

    private func startEditing() {
        isEditing = true
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            NSApp.windows.first?.makeKey()
            isFocused = true
        }
    }

    private func stopEditing() {
        isEditing = false
        inputText = ""
        isFocused = false
    }
}

#Preview {
    ContentView() {}
}
