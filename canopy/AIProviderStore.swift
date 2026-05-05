//
//  AIProviderStore.swift
//  canopy
//

import Combine
import ConvexMobile
import Foundation

private struct PreferredModelResult: Decodable {
    let preferredModel: String?
}

/// Shared store for the active AI provider.
/// Persists immediately to UserDefaults and syncs bidirectionally with Convex.
final class AIProviderStore: ObservableObject {
    static let shared = AIProviderStore()

    @Published private(set) var chatProvider: ChatProvider

    private static let defaultsKey = "preferredModel"
    private var convexSub: AnyCancellable?

    private init() {
        let raw = UserDefaults.standard.string(forKey: Self.defaultsKey) ?? ""
        chatProvider = ChatProvider.from(rawValue: raw) ?? .defaultGoogle
        ChatAPI.warmUp()
        subscribeToConvex()
    }

    func setProvider(_ provider: ChatProvider) {
        guard provider.rawValue != chatProvider.rawValue else { return }
        chatProvider = provider
        UserDefaults.standard.set(provider.rawValue, forKey: Self.defaultsKey)
        Task { @MainActor in
            try? await convex.mutation(
                "users:updatePreferredModel",
                with: ["model": provider.rawValue] as [String: ConvexEncodable?]
            )
        }
    }

    private func subscribeToConvex() {
        convexSub = convex
            .subscribe(to: "users:getPreferredModel", with: [:] as [String: ConvexEncodable?])
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { _ in },
                receiveValue: { [weak self] (result: PreferredModelResult) in
                    guard let self,
                          let raw = result.preferredModel,
                          let provider = ChatProvider.from(rawValue: raw),
                          provider.rawValue != self.chatProvider.rawValue else { return }
                    self.chatProvider = provider
                    UserDefaults.standard.set(raw, forKey: Self.defaultsKey)
                }
            )
    }
}
