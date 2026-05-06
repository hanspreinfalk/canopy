//
//  GuideOverlayController.swift
//  canopy
//
//  Renders the blue "flying triangle" cursor used by the take_screenshot
//  tool to point at on-screen UI elements.
//
//  Design:
//    - We mount one transparent, click-through NSPanel that exactly covers
//      the target display. The panel is borderless, screensaver-level, joins
//      every Space, and ignores mouse events so it never gets in the user's
//      way.
//    - SwiftUI inside the panel positions a small triangle. We animate the
//      triangle's position with a Bezier arc (start point → control point →
//      end point) using a 60 fps timer, just like the reference. Linear
//      progress is smoothed via cubic ease-in-out so motion accelerates and
//      then settles on the target.
//    - The triangle rotates to follow the curve tangent during flight, then
//      eases back to a fixed -35° pointer pose at the destination so it
//      looks like it's pointing at the element rather than mid-flight.
//    - After holding the pointing pose briefly the panel fades and tears
//      down. Subsequent calls reuse the panel (cheaper than rebuilding).
//
//  Coordinate spaces:
//    - The caller hands us a global AppKit point (bottom-left origin).
//    - We compute the panel's frame from the chosen NSScreen and translate
//      the global point into SwiftUI window-local space (top-left origin):
//        local.x = global.x - displayFrame.minX
//        local.y = displayFrame.maxY - global.y
//    - SwiftUI's `.position` places the CENTER of the view at the given
//      point, so we nudge slightly so the triangle's tip lands on the
//      element rather than its center.
//

import AppKit
import Combine
import SwiftUI

@MainActor
final class GuideOverlayController {
    static let shared = GuideOverlayController()

    private var panel: NSPanel?
    private var hostingController: NSHostingController<GuideOverlayHost>?
    private var state = GuideOverlayState()
    /// Pending teardown after `dismiss(animated: true)`. Stored so a new
    /// `showPointing` call can cancel the teardown and reuse the panel.
    private var pendingTeardown: DispatchWorkItem?

    private init() {}

    /// Shows the triangle on the screen that contains `displayFrame`, flying
    /// from a sensible start point to the global-AppKit `target`. Auto-fades
    /// and tears down after the pointing animation completes.
    /// - Parameters:
    ///   - target: Global AppKit point (bottom-left origin) to point at.
    ///   - displayFrame: The full frame of the display the target lives on.
    ///   - label: Optional short label (e.g. "Dark Mode toggle"); shown in
    ///     a small bubble next to the triangle while it points.
    func showPointing(
        toGlobalAppKit target: CGPoint,
        on displayFrame: CGRect,
        label: String?
    ) {
        guard displayFrame.width > 0, displayFrame.height > 0 else { return }

        // If a previous overlay is mid-fade-out, cancel its scheduled
        // teardown so we can reuse the panel for this new flight.
        pendingTeardown?.cancel()
        pendingTeardown = nil

        let panel = ensurePanel(coveringDisplayFrame: displayFrame)

        // Compute SwiftUI-local target. Apply a tiny offset so the triangle's
        // tip — not its center — appears to rest on the element. The values
        // below match the rotated -35° pose used while pointing.
        let swiftUITarget = CGPoint(
            x: target.x - displayFrame.minX,
            y: displayFrame.maxY - target.y
        )
        let pointerOffset = CGPoint(x: 8, y: 12)
        let offsetTarget = CGPoint(
            x: swiftUITarget.x + pointerOffset.x,
            y: swiftUITarget.y + pointerOffset.y
        )

        // Clamp into the visible window so the triangle never disappears
        // off-screen even if Claude returned a coord on the very edge.
        let margin: CGFloat = 24
        let clampedTarget = CGPoint(
            x: max(margin, min(offsetTarget.x, displayFrame.width - margin)),
            y: max(margin, min(offsetTarget.y, displayFrame.height - margin))
        )

        // Pick a start position: the cursor if it's on this display, else
        // a point near the bottom-center of the panel.
        let mouseLocation = NSEvent.mouseLocation
        let startGlobalAppKit: CGPoint
        if displayFrame.contains(mouseLocation) {
            startGlobalAppKit = mouseLocation
        } else {
            startGlobalAppKit = CGPoint(x: displayFrame.midX, y: displayFrame.minY + 80)
        }
        let swiftUIStart = CGPoint(
            x: startGlobalAppKit.x - displayFrame.minX,
            y: displayFrame.maxY - startGlobalAppKit.y
        )

        state.cancelAnimation()
        state.size = displayFrame.size
        state.start = swiftUIStart
        state.target = clampedTarget
        state.label = (label ?? "").trimmingCharacters(in: .whitespaces)
        state.phase = .preparing

        panel.orderFrontRegardless()

        // Tiny delay so SwiftUI has time to mount with the start position
        // before we animate to the target. Otherwise the spring on `position`
        // can momentarily collapse start and end into the same frame.
        DispatchQueue.main.async { [weak self] in
            self?.state.startFlight()
        }
    }

    /// Tears down immediately. Used when the user starts a new turn, etc.
    func dismiss(animated: Bool = true) {
        pendingTeardown?.cancel()
        pendingTeardown = nil
        state.cancelAnimation()
        guard let panel else { return }

        if animated {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                panel.animator().alphaValue = 0
            }
            // Tear down after the fade. We avoid the runAnimationGroup
            // completionHandler because it fires from a Sendable closure
            // and Swift can't see that we're already on the main actor.
            // If a new showPointing arrives before this fires, it'll cancel
            // this work item and reuse the panel.
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.panel?.orderOut(nil)
                self.panel?.alphaValue = 1
                self.state.reset()
            }
            pendingTeardown = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.20, execute: work)
        } else {
            panel.orderOut(nil)
            panel.alphaValue = 1
            state.reset()
        }
    }

    // MARK: - Internals

    private func ensurePanel(coveringDisplayFrame displayFrame: CGRect) -> NSPanel {
        if let panel {
            // Re-target if the display geometry changed (e.g. display
            // hot-plug or resolution change between calls).
            if panel.frame != displayFrame {
                panel.setFrame(displayFrame, display: false)
            }
            panel.alphaValue = 1
            return panel
        }

        let p = NSPanel(
            contentRect: displayFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        p.isFloatingPanel = true
        p.level = .screenSaver
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.isMovable = false
        p.hidesOnDeactivate = false
        p.collectionBehavior = [
            .canJoinAllSpaces,
            .stationary,
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]
        p.isReleasedWhenClosed = false

        let host = NSHostingController(rootView: GuideOverlayHost(state: state))
        host.view.frame = NSRect(origin: .zero, size: displayFrame.size)
        // Make sure the hosting view itself is fully transparent.
        host.view.wantsLayer = true
        host.view.layer?.backgroundColor = .clear

        p.contentView = host.view

        self.panel = p
        self.hostingController = host
        return p
    }
}

// MARK: - Overlay state (Observable)

/// All the transient animation state for the overlay. Lives outside the
/// SwiftUI view so the controller can drive it imperatively (timer-based
/// Bezier interpolation) while SwiftUI just observes.
@MainActor
final class GuideOverlayState: ObservableObject {
    enum Phase: Equatable {
        case idle
        case preparing
        case flying
        case pointing
        case dismissing
    }

    /// The size of the window we're rendering inside, in SwiftUI points
    /// (top-left origin).
    @Published var size: CGSize = .zero
    @Published var start: CGPoint = .zero
    @Published var target: CGPoint = .zero
    @Published var current: CGPoint = .zero
    @Published var rotationDegrees: Double = -35
    @Published var scale: CGFloat = 1.0
    @Published var opacity: Double = 0.0
    @Published var label: String = ""
    @Published var labelOpacity: Double = 0.0
    @Published var labelScale: CGFloat = 0.5
    @Published var phase: Phase = .idle {
        didSet { handlePhaseTransition(from: oldValue) }
    }

    private var animationTimer: Timer?
    private var pointHoldTask: DispatchWorkItem?

    func startFlight() {
        guard phase == .preparing else { return }
        current = start
        opacity = 1.0
        scale = 1.0
        rotationDegrees = -35
        labelOpacity = 0.0
        labelScale = 0.5

        phase = .flying
        animateBezierFlightArc()
    }

    func cancelAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
        pointHoldTask?.cancel()
        pointHoldTask = nil
    }

    func reset() {
        cancelAnimation()
        opacity = 0
        labelOpacity = 0
        phase = .idle
        label = ""
    }

    // MARK: Phase transitions

    private func handlePhaseTransition(from old: Phase) {
        if old != .pointing && phase == .pointing {
            // Show the label bubble (if any) and hold pointing for ~2.4s.
            if !label.isEmpty {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    labelOpacity = 1.0
                    labelScale = 1.0
                }
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.startFadeOut()
            }
            pointHoldTask = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.4, execute: work)
        }
    }

    private func startFadeOut() {
        phase = .dismissing
        withAnimation(.easeOut(duration: 0.4)) {
            opacity = 0
            labelOpacity = 0
        }
        // Tear the panel down AFTER the fade — but only if we're still in
        // the dismissing phase by then. A new flight (showPointing called
        // again before the fade completes) will have flipped phase back to
        // `.flying`, in which case we leave the panel alone.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            guard let self else { return }
            guard self.phase == .dismissing else { return }
            GuideOverlayController.shared.dismiss(animated: false)
        }
    }

    // MARK: Bezier flight

    private func animateBezierFlightArc() {
        animationTimer?.invalidate()

        let startPos = start
        let endPos = target

        let dx = endPos.x - startPos.x
        let dy = endPos.y - startPos.y
        let distance = hypot(dx, dy)

        // Slightly slower than instantaneous, faster than dawdling.
        let durationSeconds = min(max(distance / 800.0, 0.55), 1.3)
        let frameInterval: Double = 1.0 / 60.0
        let totalFrames = max(1, Int(durationSeconds / frameInterval))

        // Quadratic Bezier with control point lifted "up" (toward smaller y
        // in SwiftUI top-left coords) so the triangle visibly arcs over.
        let mid = CGPoint(x: (startPos.x + endPos.x) / 2.0, y: (startPos.y + endPos.y) / 2.0)
        let arcHeight = min(distance * 0.22, 100)
        let control = CGPoint(x: mid.x, y: mid.y - arcHeight)

        var frame = 0
        animationTimer = Timer.scheduledTimer(withTimeInterval: frameInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            // Advance MainActor-bound state from a Timer callback by
            // hopping back onto the main actor.
            DispatchQueue.main.async {
                frame += 1

                if frame >= totalFrames {
                    self.animationTimer?.invalidate()
                    self.animationTimer = nil
                    self.current = endPos
                    self.scale = 1.0
                    // Snap back to the resting pointer angle.
                    withAnimation(.easeInOut(duration: 0.25)) {
                        self.rotationDegrees = -35
                    }
                    self.phase = .pointing
                    return
                }

                let linear = Double(frame) / Double(totalFrames)
                // Smoothstep: 3t^2 - 2t^3 — eases in and out.
                let t = linear * linear * (3.0 - 2.0 * linear)
                let oneMinusT = 1.0 - t

                let bx = oneMinusT * oneMinusT * startPos.x
                       + 2.0 * oneMinusT * t * control.x
                       + t * t * endPos.x
                let by = oneMinusT * oneMinusT * startPos.y
                       + 2.0 * oneMinusT * t * control.y
                       + t * t * endPos.y
                self.current = CGPoint(x: bx, y: by)

                // Tangent of the bezier curve at parameter t. Rotation 0°
                // points the triangle UP (negative y), so add 90° to align
                // the tip with the direction of travel.
                let tangentX = 2.0 * oneMinusT * (control.x - startPos.x)
                             + 2.0 * t * (endPos.x - control.x)
                let tangentY = 2.0 * oneMinusT * (control.y - startPos.y)
                             + 2.0 * t * (endPos.y - control.y)
                self.rotationDegrees = atan2(tangentY, tangentX) * (180.0 / .pi) + 90.0

                // Mid-flight scale pulse: bigger when in motion, settling
                // back to 1.0 at the end. sin(πt) peaks at 1 around t=0.5.
                let pulse = sin(linear * .pi)
                self.scale = 1.0 + pulse * 0.3
            }
        }
        // Ensure the timer keeps firing during nested run loop modes
        // (e.g. while a menu is open).
        if let t = animationTimer {
            RunLoop.main.add(t, forMode: .common)
        }
    }
}

// MARK: - SwiftUI overlay

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let size = min(rect.width, rect.height)
        let height = size * sqrt(3.0) / 2.0
        path.move(to: CGPoint(x: rect.midX, y: rect.midY - height / 1.5))
        path.addLine(to: CGPoint(x: rect.midX - size / 2, y: rect.midY + height / 3))
        path.addLine(to: CGPoint(x: rect.midX + size / 2, y: rect.midY + height / 3))
        path.closeSubpath()
        return path
    }
}

private struct GuideOverlayHost: View {
    @ObservedObject var state: GuideOverlayState

    private static let triangleColor = Color(red: 0.20, green: 0.55, blue: 1.0)

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Transparent backdrop. SwiftUI needs SOMETHING to size against
            // for the .position modifier to behave correctly.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)

            // Label bubble, positioned to the upper-right of the triangle.
            if !state.label.isEmpty {
                Text(state.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Self.triangleColor)
                    )
                    .scaleEffect(state.labelScale, anchor: .topLeading)
                    .opacity(state.labelOpacity)
                    .position(x: state.current.x + 64, y: state.current.y - 14)
                    .allowsHitTesting(false)
                    .animation(.easeInOut(duration: 0.2), value: state.current)
            }

            Triangle()
                .fill(Self.triangleColor)
                .frame(width: 18, height: 18)
                .rotationEffect(.degrees(state.rotationDegrees))
                .shadow(color: Self.triangleColor.opacity(0.85), radius: 10 + (state.scale - 1.0) * 16, x: 0, y: 0)
                .scaleEffect(state.scale)
                .opacity(state.opacity)
                .position(state.current)
                .allowsHitTesting(false)
                .animation(.easeInOut(duration: 0.2), value: state.opacity)
        }
        .frame(width: state.size.width, height: state.size.height, alignment: .topLeading)
        .background(Color.clear)
    }
}
