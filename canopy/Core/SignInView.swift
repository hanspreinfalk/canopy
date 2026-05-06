//
//  SignInView.swift
//  canopy
//

import AppKit
import ClerkKit
import SwiftUI

struct SignInView: View {
    @Environment(\.colorScheme) private var colorScheme

    @State private var errorMessage: String?
    @State private var primaryHovered = false
    @State private var secondaryHovered = false

    var body: some View {
        ZStack {
            backgroundGradient
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 28)

                signInCard
                    .padding(.horizontal, 36)
                    .padding(.bottom, 32)

                Spacer(minLength: 28)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var backgroundGradient: some View {
        LinearGradient(
            colors: [
                Color(NSColor.windowBackgroundColor),
                Color(NSColor.windowBackgroundColor).opacity(0.96),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private var signInCard: some View {
        VStack(spacing: 22) {
            brandHeader

            VStack(spacing: 10) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundColor(Color.red.opacity(0.9))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                signUpButton
                signInButton
            }
        }
        .padding(26)
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.12 : 0.05), radius: 10, x: 0, y: 3)
    }

    private var brandHeader: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5)
                Image(systemName: "leaf.fill")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundColor(.primary.opacity(0.9))
                    .accessibilityHidden(true)
            }
            .frame(width: 54, height: 54)

            VStack(spacing: 5) {
                Text("Canopy")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(.primary)
                Text("Your AI voice assistant")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var signUpButton: some View {
        Button {
            errorMessage = nil
            Task {
                do {
                    try await Clerk.shared.auth.signUpWithOAuth(provider: .google)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        } label: {
            Text("Sign up with Google")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(ctaPrimaryLabel)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(ctaPrimaryBackground)
                )
        }
        .buttonStyle(.plain)
        .onHover { primaryHovered = $0 }
    }

    private var signInButton: some View {
        Button {
            errorMessage = nil
            Task {
                do {
                    try await Clerk.shared.auth.signInWithOAuth(provider: .google, transferable: false)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        } label: {
            Text("Sign in with Google")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(secondaryButtonFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
                )
        }
        .buttonStyle(.plain)
        .onHover { secondaryHovered = $0 }
    }

    private var ctaPrimaryBackground: Color {
        let base = colorScheme == .dark ? Color.white : Color.black
        if primaryHovered {
            return colorScheme == .dark ? Color.white.opacity(0.92) : Color.black.opacity(0.86)
        }
        return base
    }

    private var ctaPrimaryLabel: Color {
        colorScheme == .dark ? Color.black : Color.white
    }

    private var secondaryButtonFill: Color {
        secondaryHovered ? Color.primary.opacity(0.09) : Color.primary.opacity(0.05)
    }
}
