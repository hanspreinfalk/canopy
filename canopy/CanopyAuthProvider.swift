//
//  CanopyAuthProvider.swift
//  canopy
//

import ClerkKit
@preconcurrency import ConvexMobile

/// Auth provider that fetches a Clerk JWT using the "convex" template, which
/// sets aud:"convex" so that Convex's auth.config.ts accepts the token.
/// Mirrors the session-sync behaviour of ClerkConvexAuthProvider.
@MainActor
final class CanopyAuthProvider: AuthProvider {
    typealias T = String

    private var onIdToken: (@Sendable (String?) -> Void)?
    private var tokenRefreshTask: Task<Void, Never>?
    private var sessionSyncTask: Task<Void, Never>?
    private weak var client: ConvexClientWithAuth<String>?

    init() {}

    /// Wire up the Convex client so session changes trigger login/logout automatically.
    func bind(to client: ConvexClientWithAuth<String>) {
        self.client = client
        startSessionSync()
    }

    // MARK: - AuthProvider

    func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await authenticate(onIdToken: onIdToken)
    }

    func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        try await authenticate(onIdToken: onIdToken)
    }

    func logout() async throws {
        tokenRefreshTask?.cancel()
        tokenRefreshTask = nil
        onIdToken = nil
        try await Clerk.shared.auth.signOut()
    }

    nonisolated func extractIdToken(from authResult: String) -> String { authResult }

    // MARK: - Private

    private func authenticate(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
        self.onIdToken = onIdToken
        let token = try await fetchConvexToken()
        startTokenRefreshListener()
        return token
    }

    private func fetchConvexToken() async throws -> String {
        guard Clerk.shared.isLoaded else { throw AuthError.clerkNotLoaded }
        guard let session = Clerk.shared.session, session.status == .active else {
            throw AuthError.noActiveSession
        }
        guard let token = try await session.getToken(.init(template: "convex")) else {
            throw AuthError.tokenRetrievalFailed
        }
        return token
    }

    private func startTokenRefreshListener() {
        tokenRefreshTask?.cancel()
        tokenRefreshTask = Task { [weak self] in
            for await event in Clerk.shared.auth.events {
                guard !Task.isCancelled else { break }
                if case .tokenRefreshed = event {
                    let fresh = try? await Clerk.shared.session?.getToken(.init(template: "convex"))
                    self?.onIdToken?(fresh)
                }
            }
        }
    }

    private func startSessionSync() {
        sessionSyncTask?.cancel()
        sessionSyncTask = Task { [weak self] in
            guard let self else { return }
            await syncSession(newSession: Clerk.shared.session)
            for await event in Clerk.shared.auth.events {
                guard !Task.isCancelled else { break }
                if case .sessionChanged(let old, let new) = event {
                    await syncSession(oldSession: old, newSession: new)
                }
            }
        }
    }

    private func syncSession(oldSession: Session? = nil, newSession: Session?) async {
        guard let client else { return }
        let isActive = newSession?.status == .active
        let wasActive = oldSession?.status == .active

        if isActive && (!wasActive || oldSession?.id != newSession?.id) {
            _ = await client.loginFromCache()
        } else if oldSession?.id != nil && newSession == nil {
            await client.logout()
        }
    }

    enum AuthError: Error {
        case clerkNotLoaded
        case noActiveSession
        case tokenRetrievalFailed
    }
}
