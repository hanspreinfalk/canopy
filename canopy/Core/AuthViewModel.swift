//
//  AuthViewModel.swift
//  canopy
//

import Combine
import Foundation
import ConvexMobile

enum AuthState: Equatable {
    case loading
    case authenticated
    case unauthenticated
}

@MainActor
class AuthViewModel: ObservableObject {
    @Published var authState: AuthState = .loading
    private var cancellables = Set<AnyCancellable>()

    private var hasEverAuthenticated = false

    init() {
        convex.authState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                switch state {
                case .loading:
                    break  // stay in current state during any loading/refresh phase
                case .authenticated:
                    hasEverAuthenticated = true
                    authState = .authenticated
                    Analytics.identifyFromClerk()
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(600))
                        Analytics.identifyFromClerk()
                    }
                case .unauthenticated:
                    // Only act on .unauthenticated after we've confirmed auth at least once —
                    // otherwise this is just the convex.authState CurrentValueSubject default
                    // or a failed initial loginFromCache, not a real sign-out.
                    if hasEverAuthenticated {
                        Analytics.resetIdentity()
                        authState = .unauthenticated
                    }
                }
            }
            .store(in: &cancellables)

        // Fallback for users with no session: Clerk loads, finds nothing, emits no further
        // events, so without this we'd stay .loading forever.
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if authState == .loading {
                authState = .unauthenticated
            }
        }
    }
}
