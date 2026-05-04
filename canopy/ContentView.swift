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
        VStack(spacing: 8) {
            mainPill
            if isHovered {
                controls
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .animation(.spring(duration: 0.25), value: isHovered)
    }

    private var mainPill: some View {
        HStack(spacing: 0) {
            Text("Click or hold ")
            Text("fn").foregroundColor(.pink).fontWeight(.semibold)
            Text(" to start dictating")
        }
        .foregroundColor(.white)
        .font(.system(size: 15, weight: .medium))
        .opacity(isHovered ? 1 : 0)
        .frame(
            width: isHovered ? 340 : PillConstants.width,
            height: isHovered ? 52 : PillConstants.height
        )
        .background(Color(red: 0.1, green: 0.1, blue: 0.1))
        .clipShape(RoundedRectangle(cornerRadius: isHovered ? 26 : PillConstants.cornerRadius))
    }

    private var controls: some View {
        HStack(spacing: 8) {
            Text("· · · · · · · · · ·")
                .foregroundColor(Color.white.opacity(0.5))
                .font(.system(size: 11))
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color(red: 0.15, green: 0.15, blue: 0.15))
                .clipShape(Capsule())

            Button { } label: {
                Image(systemName: "wand.and.rays")
                    .foregroundColor(.white)
                    .font(.system(size: 14))
            }
            .buttonStyle(.plain)
            .frame(width: 38, height: 38)
            .background(Color(red: 0.15, green: 0.15, blue: 0.15))
            .clipShape(Circle())
        }
    }
}

#Preview {
    ContentView() {}
}
