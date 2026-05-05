//
//  FnKeyMonitor.swift
//  canopy
//

import AppKit

/// Monitors the fn/Globe key globally via flagsChanged events.
/// Calls onFnDown when the key is pressed and onFnUp when released.
final class FnKeyMonitor {
    var onFnDown: (() -> Void)?
    var onFnUp: (() -> Void)?

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var isFnDown = false

    func start() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }
        // Local monitor handles fn presses when our window is key
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }
    }

    func stop() {
        if let m = globalMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor  { NSEvent.removeMonitor(m) }
        globalMonitor = nil
        localMonitor = nil
        isFnDown = false
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        let fnNowDown = event.modifierFlags.contains(.function)
        if fnNowDown && !isFnDown {
            isFnDown = true
            onFnDown?()
        } else if !fnNowDown && isFnDown {
            isFnDown = false
            onFnUp?()
        }
    }

    deinit { stop() }
}
