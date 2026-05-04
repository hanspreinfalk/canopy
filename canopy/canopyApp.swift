//
//  canopyApp.swift
//  canopy
//

import SwiftUI
import ClerkKit
import ConvexMobile

@MainActor
private let _convexAuthProvider = CanopyAuthProvider()

@MainActor
let convex = ConvexClientWithAuth(
    deploymentUrl: "https://oceanic-opossum-563.convex.cloud",
    authProvider: _convexAuthProvider as any AuthProvider<String>
)

@main
struct canopyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    init() {
        let key = AppBundleConfiguration.stringValue(forKey: "CLERK_PUBLISHABLE_KEY") ?? ""
        Clerk.configure(
            publishableKey: key,
            options: .init(
                keychainConfig: .init(
                    service: "com.hanspreinfalk.canopy",
                    accessGroup: "8HNTB9PEFY.com.hanspreinfalk.canopy"
                )
            )
        )
        Task { @MainActor in
            _convexAuthProvider.bind(to: convex)
        }
    }

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
