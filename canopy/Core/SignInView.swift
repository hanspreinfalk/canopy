//
//  SignInView.swift
//  canopy
//

import SwiftUI
import ClerkKit

struct SignInView: View {
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 10) {
                Image(systemName: "leaf.fill")
                    .font(.system(size: 44))
                    .foregroundColor(.green)
                Text("Canopy")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(.white)
                Text("Your AI voice assistant")
                    .font(.system(size: 14))
                    .foregroundColor(.white.opacity(0.55))
            }

            Spacer()

            VStack(spacing: 10) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11))
                        .foregroundColor(Color.red.opacity(0.85))
                        .multilineTextAlignment(.center)
                }

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
                    Text("Sign Up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(Color(red: 0.08, green: 0.08, blue: 0.08))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)

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
                    Text("Sign In")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white.opacity(0.75))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.white.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 40)
            .padding(.bottom, 44)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.08, green: 0.08, blue: 0.08))
    }
}
