//
//  ConnectorsViewModel.swift
//  canopy
//

import AppKit
import Foundation
import Combine
import ClerkKit

// v3 toolkits response: { slug, name, meta: { logo, description } }
private struct ComposioAppMeta: Decodable {
    let logo: String?
    let description: String?
}

struct ComposioApp: Identifiable, Decodable {
    var id: String { slug }
    let slug: String
    let name: String
    let logo: String?
    let description: String?

    private enum CodingKeys: String, CodingKey { case slug, name, meta }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        name = try c.decode(String.self, forKey: .name)
        let meta = try? c.decode(ComposioAppMeta.self, forKey: .meta)
        logo = meta?.logo
        description = meta?.description
    }
}

// v3 connected_accounts response: { connected_account_id, toolkit: { slug, name }, status }
struct ComposioConnectionToolkit: Decodable {
    let slug: String
    let name: String?
}

struct ComposioConnection: Identifiable, Decodable {
    let id: String
    let toolkit: ComposioConnectionToolkit
    let status: String

    var isActive: Bool { status == "ACTIVE" }
    var appSlug: String { toolkit.slug }
}

@MainActor
final class ConnectorsViewModel: ObservableObject {
    static let shared = ConnectorsViewModel()

    @Published var apps: [ComposioApp] = []
    @Published var connections: [ComposioConnection] = []
    @Published var isLoading = false
    @Published var connectingAppKey: String? = nil
    @Published var errorMessage: String?

    private static let baseURL = "https://oceanic-opossum-563.convex.site"

    var userId: String {
        Clerk.shared.user?.id ?? "default"
    }

    var connectedAppSlugs: Set<String> {
        Set(connections.filter { $0.isActive }.map { $0.appSlug.lowercased() })
    }

    var hasConnections: Bool { !connectedAppSlugs.isEmpty }

    private init() {
        // When the user completes OAuth in the browser and returns to the app,
        // automatically refresh connections so the button updates to "Connected".
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.refreshConnections()
            }
        }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadApps() }
            group.addTask { await self.loadConnections() }
        }
    }

    func refreshConnections() async {
        await loadConnections()
    }

    private func loadApps() async {
        guard let url = URL(string: "\(Self.baseURL)/composio/apps") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            struct Resp: Decodable { let items: [ComposioApp] }
            apps = try JSONDecoder().decode(Resp.self, from: data).items
            let sample = apps.prefix(3).map { "\($0.slug): logo=\($0.logo ?? "nil")" }
            print("📦 composio/apps loaded \(apps.count) apps, sample logos: \(sample)")
        } catch {
            print("❌ ConnectorsViewModel.loadApps: \(error)")
        }
    }

    private func loadConnections() async {
        let uid = userId
        guard let url = URL(string: "\(Self.baseURL)/composio/connections?userId=\(uid)") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let raw = String(data: data, encoding: .utf8) {
                print("🔗 composio/connections: \(raw.prefix(300))")
            }
            struct Resp: Decodable { let items: [ComposioConnection] }
            connections = try JSONDecoder().decode(Resp.self, from: data).items
        } catch {
            print("❌ ConnectorsViewModel.loadConnections: \(error)")
        }
    }

    // Returns the OAuth redirect URL to open in the browser.
    func initiateConnection(appSlug: String) async -> URL? {
        connectingAppKey = appSlug
        defer { connectingAppKey = nil }

        guard let url = URL(string: "\(Self.baseURL)/composio/connect") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "userId": userId,
            "toolkitSlug": appSlug,
        ])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let raw = String(data: data, encoding: .utf8) {
                print("🔌 composio/connect [\(appSlug)]: \(raw)")
            }

            let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]

            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                let msg = json["error"] as? String ?? json["message"] as? String ?? "HTTP \(http.statusCode)"
                errorMessage = msg
                return nil
            }

            // v3 field is redirect_url (snake_case)
            let urlString = json["redirect_url"] as? String
                ?? json["redirectUrl"] as? String
                ?? json["connectionUrl"] as? String

            if let urlString, let redirectUrl = URL(string: urlString) {
                return redirectUrl
            }

            errorMessage = "No redirect URL in response. Keys: \(json.keys.joined(separator: ", "))"
        } catch {
            errorMessage = "Connection failed: \(error.localizedDescription)"
            print("❌ ConnectorsViewModel.connect(\(appSlug)): \(error)")
        }
        return nil
    }

    func disconnect(connection: ComposioConnection) async {
        guard let url = URL(string: "\(Self.baseURL)/composio/disconnect") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["connectionId": connection.id])
        _ = try? await URLSession.shared.data(for: request)
        connections.removeAll { $0.id == connection.id }
    }
}
