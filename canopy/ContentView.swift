//
//  ContentView.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import SwiftUI

struct ContentView: View {
    @State private var isHovered = false
    var dismiss: () -> ()

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(alignment: .center, spacing: 8) {
                if isHovered {
                    hintPill
                        .transition(.asymmetric(
                            insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                            removal: .opacity.animation(.easeOut(duration: 0.1))
                        ))
                }
                HStack(alignment: .bottom, spacing: 8) {
                    mainPill
                    if isHovered {
                        wandButton
                            .transition(.asymmetric(
                                insertion: .opacity.animation(.easeIn(duration: 0.15).delay(0.2)),
                                removal: .opacity.animation(.easeOut(duration: 0.1))
                            ))
                    }
                }
            }
            .offset(x: isHovered ? 20 : 0)
            .onHover { isHovered = $0 }
        }
        .animation(.easeInOut(duration: 0.3), value: isHovered)
    }

    private var mainPill: some View {
        ZStack {
            if isHovered {
                Text("· · · · · · · · · ·")
                    .foregroundColor(.white.opacity(0.5))
                    .font(.system(size: 11))
                    .transition(.opacity.animation(.easeIn(duration: 0.15).delay(0.15)))
            }
        }
        .frame(
            width: isHovered ? 80 : PillConstants.width,
            height: isHovered ? 28 : PillConstants.height
        )
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(RoundedRectangle(cornerRadius: isHovered ? 14 : PillConstants.cornerRadius))
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

    private var wandButton: some View {
        Button { } label: {
            Image(systemName: "wand.and.rays")
                .foregroundColor(.white)
                .font(.system(size: 14))
        }
        .buttonStyle(.plain)
        .frame(width: 28, height: 28)
        .background(Color(red: 0.15, green: 0.15, blue: 0.15))
        .clipShape(Circle())
    }
}

#Preview {
    ContentView() {}
}
