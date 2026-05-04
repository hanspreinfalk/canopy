//
//  AppDelegate.swift
//  canopy
//

import AppKit
import ClerkKit
import HotKey
import SwiftUI
import Combine

class AppDelegate: NSObject, NSApplicationDelegate {
    private var pillWindow: ContentPanel?
    private var onboardingWindow: NSWindow?
    private var conversationsWindow: NSWindow?
    var hotKey: HotKey?
    var statusItem: NSStatusItem?
    let authViewModel = AuthViewModel()
    private var authCancellable: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        setupStatusItem()
        setupHotkey()
        setupWindows()
    }

    private func setupWindows() {
        pillWindow = ContentPanel()
        onboardingWindow = makeOnboardingWindow()

        authCancellable = authViewModel.$authState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.updateWindows(for: state)
            }
    }

    private func updateWindows(for state: AuthState) {
        statusItem?.menu = buildStatusMenu()
        switch state {
        case .loading:
            onboardingWindow?.orderOut(nil)
            pillWindow?.orderOut(nil)
        case .unauthenticated:
            pillWindow?.orderOut(nil)
            onboardingWindow?.makeKeyAndOrderFront(nil)
        case .authenticated:
            onboardingWindow?.orderOut(nil)
            pillWindow?.makeKeyAndOrderFront(nil)
            pillWindow?.makeKey()
        }
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Canopy", action: #selector(openCanopy), keyEquivalent: "")
        if authViewModel.authState == .authenticated {
            menu.addItem(withTitle: "Open Main View", action: #selector(openConversations), keyEquivalent: "")
            menu.addItem(withTitle: "Log Out", action: #selector(logOut), keyEquivalent: "")
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        return menu
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "leaf.fill", accessibilityDescription: "Canopy")
        }
        statusItem?.menu = buildStatusMenu()
    }

    private func buildStatusMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Canopy", action: #selector(openCanopy), keyEquivalent: "")
        if authViewModel.authState == .authenticated {
            menu.addItem(withTitle: "Open Main View", action: #selector(openConversations), keyEquivalent: "")
            menu.addItem(withTitle: "Log Out", action: #selector(logOut), keyEquivalent: "")
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    @objc private func openCanopy() {
        NSApp.activate(ignoringOtherApps: true)
        updateWindows(for: authViewModel.authState)
    }

    @objc private func logOut() {
        Task {
            try? await Clerk.shared.auth.signOut()
        }
    }

    @objc private func openConversations() {
        if conversationsWindow == nil {
            conversationsWindow = makeConversationsWindow()
        }
        NSApp.activate(ignoringOtherApps: true)
        conversationsWindow?.makeKeyAndOrderFront(nil)
    }

    private func makeConversationsWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: CGSize(width: 780, height: 560)),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Canopy"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.contentView = NSHostingView(rootView: MainView())
        window.center()
        window.setFrameAutosaveName("ConversationsWindow")
        return window
    }

    private func setupHotkey() {
        hotKey = HotKey(key: .a, modifiers: [.command, .shift])
        hotKey?.keyDownHandler = { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.authViewModel.authState == .authenticated else { return }
                self.pillWindow?.makeKeyAndOrderFront(nil)
                self.pillWindow?.makeKey()
            }
        }
    }

    private func makeOnboardingWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: CGSize(width: 420, height: 340)),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.08, green: 0.08, blue: 0.08, alpha: 1.0)
        window.isMovableByWindowBackground = true

        window.contentView = NSHostingView(rootView: SignInView())
        window.center()
        return window
    }
}
