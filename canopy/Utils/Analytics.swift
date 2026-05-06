//
//  Analytics.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import ClerkKit
import Foundation
import PostHog

enum Analytics {
    private static var isSetup = false

    // MARK: - Setup

    static func configure() {
        guard !isSetup,
              let token = AppBundleConfiguration.stringValue(forKey: "PostHogAPIKey")
        else { return }

        let hostString = AppBundleConfiguration.stringValue(forKey: "PostHogHost") ?? PostHogConfig.defaultHost
        let config = PostHogConfig(projectToken: token, host: hostString)
        #if os(macOS)
        config.captureScreenViews = false
        #endif
        PostHogSDK.shared.setup(config)
        isSetup = true
    }

    // MARK: - Identity

    /// Associates PostHog events with the signed-in Clerk user (`distinct_id` = Clerk user id,
    /// person properties `email` and `name` when available).
    static func identifyFromClerk() {
        guard isSetup else { return }
        guard let user = Clerk.shared.user else { return }

        let distinctId = user.id
        guard !distinctId.isEmpty else { return }

        var props: [String: Any] = [:]
        if let email = user.primaryEmailAddress?.emailAddress?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !email.isEmpty {
            props["email"] = email
        }
        if let name = displayName(for: user) {
            props["name"] = name
        }

        PostHogSDK.shared.identify(distinctId, userProperties: props.isEmpty ? nil : props)
    }

    /// Prefer `"First Last"` from Clerk, then username if no name parts are set.
    private static func displayName(for user: User) -> String? {
        let first = user.firstName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let last = user.lastName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let combined = [first, last].filter { !$0.isEmpty }.joined(separator: " ")
        if !combined.isEmpty { return combined }

        if let username = user.username?.trimmingCharacters(in: .whitespacesAndNewlines),
           !username.isEmpty {
            return username
        }

        return nil
    }

    /// Clears identity when the user signs out (returns to anonymous tracking).
    static func resetIdentity() {
        guard isSetup else { return }
        PostHogSDK.shared.reset()
    }

    private static func capture(_ event: String, properties: [String: Any]? = nil) {
        guard isSetup else { return }
        PostHogSDK.shared.capture(event, properties: properties)
    }

    // MARK: - App Lifecycle

    /// Fired once on every app launch in applicationDidFinishLaunching.
    static func trackAppOpened() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        capture("app_opened", properties: [
            "app_version": version,
        ])
    }

    // MARK: - Onboarding

    /// User clicked the Start button to begin onboarding for the first time.
    static func trackOnboardingStarted() {
        capture("onboarding_started")
    }

    /// User clicked "Watch Onboarding Again" from the panel footer.
    static func trackOnboardingReplayed() {
        capture("onboarding_replayed")
    }

    /// The onboarding video finished playing to the end.
    static func trackOnboardingVideoCompleted() {
        capture("onboarding_video_completed")
    }

    /// The 40s onboarding demo interaction where Clicky points at something.
    static func trackOnboardingDemoTriggered() {
        capture("onboarding_demo_triggered")
    }

    // MARK: - Permissions

    /// All three permissions (accessibility, screen recording, mic) are granted.
    static func trackAllPermissionsGranted() {
        capture("all_permissions_granted")
    }

    /// A single permission was granted. Called when polling detects a change.
    static func trackPermissionGranted(permission: String) {
        capture("permission_granted", properties: [
            "permission": permission,
        ])
    }

    // MARK: - Voice Interaction

    /// User began voice dictation (fn hold or pill tap after recording starts).
    static func trackPushToTalkStarted() {
        capture("push_to_talk_started")
    }

    /// User ended dictation (fn release or stop).
    static func trackPushToTalkReleased() {
        capture("push_to_talk_released")
    }

    /// Transcription completed and the user's message is being sent to the AI.
    static func trackUserMessageSent(transcript: String) {
        capture("user_message_sent", properties: [
            "transcript": transcript,
            "character_count": transcript.count,
        ])
    }

    /// Assistant responded and the response is being spoken via TTS.
    static func trackAIResponseReceived(response: String) {
        capture("ai_response_received", properties: [
            "response": response,
            "character_count": response.count,
        ])
    }

    /// The screenshot locate flow found a target and the buddy is pointing at it.
    static func trackElementPointed(elementLabel: String?) {
        capture("element_pointed", properties: [
            "element_label": elementLabel ?? "unknown",
        ])
    }

    // MARK: - Errors

    /// An error occurred during the AI response pipeline.
    static func trackResponseError(error: String) {
        capture("response_error", properties: [
            "error": error,
        ])
    }

    /// An error occurred during TTS playback.
    static func trackTTSError(error: String) {
        capture("tts_error", properties: [
            "error": error,
        ])
    }
}
