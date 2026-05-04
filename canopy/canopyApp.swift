//
//  canopyApp.swift
//  canopy
//

import SwiftUI
import ClerkKit
import ClerkConvex
import ConvexMobile

@MainActor
let convex = ConvexClientWithAuth(
    deploymentUrl: "https://oceanic-opossum-563.convex.cloud",
    authProvider: ClerkConvexAuthProvider()
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
    }

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
