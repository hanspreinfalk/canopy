//
//  AppDelegate.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import AppKit
import HotKey

class AppDelegate: NSObject, NSApplicationDelegate {
    var contentWindow: NSWindow?
    var hotKey: HotKey?
    var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        setupStatusItem()
        showContentWindow()
        setupHotkey()
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Canopy", action: #selector(openCanopy), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        return menu
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "leaf.fill", accessibilityDescription: "Canopy")
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "Open Canopy", action: #selector(openCanopy), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem?.menu = menu
    }

    @objc private func openCanopy() {
        NSApp.activate(ignoringOtherApps: true)
        showContentWindow()
    }

    private func setupHotkey() {
        hotKey = HotKey(key: .a, modifiers: [.command, .shift])
        hotKey?.keyDownHandler = { [weak self] in
            DispatchQueue.main.async {
                self?.showContentWindow()
            }
        }
    }
    
    func showContentWindow() {
        self.closeReviewWindow()
        
        let contentPanel = ContentPanel()
        
        contentWindow = contentPanel
        
        contentPanel.makeKeyAndOrderFront(nil)
        contentPanel.makeKey()
    }
    
    private func closeReviewWindow() {
        if let window = contentWindow {
            window.close()
            contentWindow = nil
        }
    }
}
