//
//  AppDelegate.swift
//  canopy
//

import AppKit
import ClerkKit
import HotKey
import SwiftUI
import Combine

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var pillWindow: ContentPanel?
    private var onboardingWindow: NSWindow?
    private var conversationsWindow: NSWindow?
    var hotKey: HotKey?
    var statusItem: NSStatusItem?
    let authViewModel = AuthViewModel()
    private var authCancellable: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Analytics.trackAppOpened()
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
            AIProviderStore.shared.connectToConvex()
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
        let menu = buildStatusMenu()
        menu.delegate = self
        statusItem?.menu = menu
    }

    // Rebuild before each open so checkmarks reflect the current provider
    func menuWillOpen(_ menu: NSMenu) {
        let fresh = buildStatusMenu()
        fresh.delegate = self
        statusItem?.menu = fresh
    }

    private func buildStatusMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Canopy", action: #selector(openCanopy), keyEquivalent: "")
        if authViewModel.authState == .authenticated {
            menu.addItem(withTitle: "Open Main View", action: #selector(openConversations), keyEquivalent: "")

            menu.addItem(.separator())

            let providerItem = NSMenuItem(title: "AI Provider", action: nil, keyEquivalent: "")
            let providerMenu = NSMenu()
            let current = AIProviderStore.shared.chatProvider.rawValue

            let options: [(title: String, raw: String)] = [
                ("Gemini 2.5 Flash",   "google:gemini-2.5-flash"),
                ("Gemini 2.5 Pro",     "google:gemini-2.5-pro"),
                ("Gemini 2.0 Flash",   "google:gemini-2.0-flash"),
                ("Claude Sonnet 4.6",  "anthropic:claude-sonnet-4-6"),
                ("Claude Opus 4.7",    "anthropic:claude-opus-4-7"),
                ("Claude Haiku 4.5",   "anthropic:claude-haiku-4-5-20251001"),
                ("GPT-4o",             "openai:gpt-4o"),
                ("GPT-4o Mini",        "openai:gpt-4o-mini"),
            ]

            for opt in options {
                let item = NSMenuItem(title: opt.title, action: #selector(selectProvider(_:)), keyEquivalent: "")
                item.representedObject = opt.raw
                item.state = opt.raw == current ? .on : .off
                providerMenu.addItem(item)
            }

            providerItem.submenu = providerMenu
            menu.addItem(providerItem)

            menu.addItem(.separator())
            menu.addItem(withTitle: "Log Out", action: #selector(logOut), keyEquivalent: "")
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    @objc private func selectProvider(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String else { return }
        DispatchQueue.main.async {
            guard let provider = ChatProvider.from(rawValue: raw) else { return }
            AIProviderStore.shared.setProvider(provider)
        }
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
            contentRect: NSRect(origin: .zero, size: CGSize(width: 440, height: 380)),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor.windowBackgroundColor
        window.isMovableByWindowBackground = true

        window.contentView = NSHostingView(rootView: SignInView())
        window.center()
        return window
    }
}
