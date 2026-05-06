//
//  ScreenCaptureUtility.swift
//  canopy
//
//  Captures the cursor screen as a JPEG and reports the geometry needed to
//  map a pixel coordinate inside that JPEG back to a global AppKit point.
//
//  Why these dimensions:
//    - The JPEG is downscaled (max 1280 on the long edge) so it stays small
//      in flight and inside Anthropic's image-token budget. Claude is told
//      the image's pixel dimensions and replies in image-pixel space.
//    - The display's "points" frame (NSScreen.frame) is the AppKit-coord
//      rectangle we render the overlay into; that's what we need to map a
//      target back into when positioning the triangle.
//    - The ratio between (image pixels) and (display points) is the only
//      conversion we apply on top of the standard top-left → bottom-left
//      AppKit y-flip.
//

import AppKit
import Foundation
import ScreenCaptureKit

/// One screen captured for the take_screenshot tool. All dimensions/frames
/// are exact at capture time so the caller can do precise coordinate math.
struct CanopyScreenCapture: Sendable {
    /// JPEG-encoded image data, ready to base64-encode and ship to the backend.
    let imageData: Data
    /// Image width in pixels (matches what Claude sees and replies in).
    let imageWidthPixels: Int
    /// Image height in pixels.
    let imageHeightPixels: Int
    /// The captured display's frame in global AppKit coordinates (bottom-left
    /// origin, y growing upward). This is `NSScreen.frame`, not `visibleFrame`.
    let displayFrame: CGRect
    /// True if the user's cursor was on this display when we captured.
    let isCursorScreen: Bool
}

enum ScreenCaptureError: LocalizedError {
    case noDisplays
    case captureFailed(underlying: Error)
    case encodingFailed
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .noDisplays: return "No displays available to capture."
        case .captureFailed(let err): return "Screen capture failed: \(err.localizedDescription)"
        case .encodingFailed: return "Could not encode screenshot as JPEG."
        case .permissionDenied:
            return "Canopy needs Screen Recording permission. Open System Settings → Privacy & Security → Screen Recording and enable Canopy."
        }
    }
}

enum ScreenCaptureUtility {
    /// The longest edge (in pixels) we ship to the backend. Smaller is faster
    /// and Claude points fine at this resolution; we mostly care about the
    /// pixel→point mapping staying lossless within ±1pt at any density.
    nonisolated static let defaultMaxDimensionPixels: Int = 1280

    /// Captures the screen the user's mouse is currently on. Excludes our own
    /// app's windows so the AI sees what the user sees, not our overlays.
    @MainActor
    static func captureCursorScreen(
        maxDimensionPixels: Int = defaultMaxDimensionPixels
    ) async throws -> CanopyScreenCapture {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            // SCShareableContent throws when permission is missing or the
            // user denied screen recording. Map to a friendlier error.
            let nsErr = error as NSError
            if nsErr.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
                || nsErr.localizedDescription.localizedCaseInsensitiveContains("permission") {
                throw ScreenCaptureError.permissionDenied
            }
            throw ScreenCaptureError.captureFailed(underlying: error)
        }

        guard !content.displays.isEmpty else { throw ScreenCaptureError.noDisplays }

        let mouseLocation = NSEvent.mouseLocation

        // Build a lookup so we can use NSScreen frames (AppKit, bottom-left
        // origin) instead of SCDisplay's CG-coord frames. They're equivalent
        // in size but their origins live in different coordinate spaces.
        var nsScreenByDisplayID: [CGDirectDisplayID: NSScreen] = [:]
        for screen in NSScreen.screens {
            if let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID {
                nsScreenByDisplayID[id] = screen
            }
        }

        // Pick the display containing the cursor; fall back to the first
        // display if for some reason none contain the cursor (rare; can
        // happen mid-resolution-change).
        let chosenDisplay: SCDisplay = content.displays.first(where: { display in
            let frame = nsScreenByDisplayID[display.displayID]?.frame
                ?? CGRect(
                    x: display.frame.origin.x,
                    y: display.frame.origin.y,
                    width: CGFloat(display.width),
                    height: CGFloat(display.height)
                )
            return frame.contains(mouseLocation)
        }) ?? content.displays[0]

        let displayFrame = nsScreenByDisplayID[chosenDisplay.displayID]?.frame
            ?? CGRect(
                x: chosenDisplay.frame.origin.x,
                y: chosenDisplay.frame.origin.y,
                width: CGFloat(chosenDisplay.width),
                height: CGFloat(chosenDisplay.height)
            )
        let isCursorScreen = displayFrame.contains(mouseLocation)

        // Don't show our own panels/overlays in the screenshot — that
        // would confuse Claude into pointing at our pill or the arrow itself.
        let ownBundleID = Bundle.main.bundleIdentifier
        let ownAppWindows = content.windows.filter { window in
            window.owningApplication?.bundleIdentifier == ownBundleID
        }
        let filter = SCContentFilter(display: chosenDisplay, excludingWindows: ownAppWindows)

        let configuration = SCStreamConfiguration()
        // Use SCDisplay's pixel dimensions (display.width/height). On Retina
        // these are the native pixel count; SCScreenshotManager will downscale
        // to whatever (configuration.width, configuration.height) we set.
        let aspect = CGFloat(chosenDisplay.width) / CGFloat(chosenDisplay.height)
        if chosenDisplay.width >= chosenDisplay.height {
            configuration.width = maxDimensionPixels
            configuration.height = max(1, Int((CGFloat(maxDimensionPixels) / aspect).rounded()))
        } else {
            configuration.height = maxDimensionPixels
            configuration.width = max(1, Int((CGFloat(maxDimensionPixels) * aspect).rounded()))
        }
        configuration.scalesToFit = true
        // BGRA8 is the default and works fine for JPEG encoding via
        // NSBitmapImageRep below. Don't change capture pixel format here.

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw ScreenCaptureError.captureFailed(underlying: error)
        }

        guard
            let jpegData = NSBitmapImageRep(cgImage: cgImage).representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.8]
            )
        else {
            throw ScreenCaptureError.encodingFailed
        }

        // Use the actual produced image dimensions — SCScreenshotManager can
        // honor `scalesToFit` differently across configurations and we want
        // to send Claude the exact width/height it'll see.
        let actualWidth = cgImage.width
        let actualHeight = cgImage.height

        return CanopyScreenCapture(
            imageData: jpegData,
            imageWidthPixels: actualWidth,
            imageHeightPixels: actualHeight,
            displayFrame: displayFrame,
            isCursorScreen: isCursorScreen
        )
    }

    /// Maps a pixel coordinate inside the screenshot (top-left origin) back to
    /// a global AppKit point (bottom-left origin) on the original display.
    ///
    /// The math, step by step:
    ///   1. Clamp the input into screenshot bounds (Claude can over/undershoot).
    ///   2. Scale from screenshot-pixel space to display-point space.
    ///   3. Flip Y (top-left → bottom-left) within the display.
    ///   4. Translate by `displayFrame.origin` to move into global coords.
    ///
    /// Returns `nil` if `displayFrame` has zero area (nothing to map into).
    static func mapImagePointToGlobalAppKit(
        imagePoint: CGPoint,
        capture: CanopyScreenCapture
    ) -> CGPoint? {
        let imageWidth = CGFloat(capture.imageWidthPixels)
        let imageHeight = CGFloat(capture.imageHeightPixels)
        guard imageWidth > 0, imageHeight > 0 else { return nil }

        let displayWidth = capture.displayFrame.width
        let displayHeight = capture.displayFrame.height
        guard displayWidth > 0, displayHeight > 0 else { return nil }

        let clampedX = max(0, min(imagePoint.x, imageWidth - 1))
        let clampedY = max(0, min(imagePoint.y, imageHeight - 1))

        let displayLocalX = clampedX * (displayWidth / imageWidth)
        let displayLocalYFromTop = clampedY * (displayHeight / imageHeight)

        // Top-left → bottom-left flip within the display.
        let displayLocalYFromBottom = displayHeight - displayLocalYFromTop

        return CGPoint(
            x: displayLocalX + capture.displayFrame.origin.x,
            y: displayLocalYFromBottom + capture.displayFrame.origin.y
        )
    }
}
