//
//  MainViewModel.swift
//  canopy
//

import Combine
import ConvexMobile
import Foundation

// MARK: - Data models

struct ConvexConversation: Decodable, Identifiable, Equatable {
    let _id: String
    let title: String?
    let lastMessageAt: Double
    let messageCount: Double

    var id: String { _id }

    var lastMessageDate: Date { Date(timeIntervalSince1970: lastMessageAt / 1000) }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        let cal = Calendar.current
        if cal.isDateInToday(lastMessageDate) {
            return "Today · " + lastMessageDate.formatted(date: .omitted, time: .shortened)
        } else if cal.isDateInYesterday(lastMessageDate) {
            return "Yesterday · " + lastMessageDate.formatted(date: .omitted, time: .shortened)
        } else {
            return lastMessageDate.formatted(date: .abbreviated, time: .shortened)
        }
    }

    var messageCountInt: Int { Int(messageCount) }
}

struct ConversationsResult: Decodable {
    let conversations: [ConvexConversation]
    let hasMore: Bool
}

struct MessagePart: Decodable, Equatable {
    let type: String
    let text: String?
}

struct ConvexMessage: Decodable, Identifiable, Equatable {
    let _id: String
    let role: String
    let parts: [MessagePart]?
    let _creationTime: Double

    var id: String { _id }

    var textContent: String {
        parts?.compactMap(\.text).joined() ?? ""
    }

    var creationDate: Date { Date(timeIntervalSince1970: _creationTime / 1000) }
}

struct MessagesResult: Decodable {
    let messages: [ConvexMessage]
    let hasMore: Bool
}

struct SelfSummaryResult: Decodable {
    let selfSummary: String?
    let selfSummaryUpdatedAt: Double?
}

// MARK: - ViewModel

@MainActor
final class MainViewModel: ObservableObject {
    @Published var conversations: [ConvexConversation] = []
    @Published var conversationsHasMore = false
    @Published var selectedConversationId: String? = nil
    @Published var messages: [ConvexMessage] = []
    @Published var messagesHasMore = false
    @Published var selfSummary: String = ""
    @Published var selfSummaryUpdatedAt: Date? = nil
    @Published var selfSummarySaving = false
    @Published var errorMessage: String? = nil

    private var conversationsNumItems: Double = 20
    private var messagesNumItems: Double = 50
    private var conversationsSub: AnyCancellable?
    private var messagesSub: AnyCancellable?
    private var selfSummarySub: AnyCancellable?

    init() {
        resubscribeConversations()
        resubscribeSelfSummary()
    }

    private func resubscribeConversations() {
        let args: [String: ConvexEncodable?] = ["numItems": conversationsNumItems]
        conversationsSub = convex
            .subscribe(to: "conversations:listConversations", with: args)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] result in
                    if case .failure(let err) = result {
                        self?.errorMessage = err.localizedDescription
                    }
                },
                receiveValue: { [weak self] (result: ConversationsResult) in
                    self?.conversations = result.conversations
                    self?.conversationsHasMore = result.hasMore
                }
            )
    }

    func loadMoreConversations() {
        conversationsNumItems += 20
        resubscribeConversations()
    }

    func selectConversation(_ id: String) {
        guard selectedConversationId != id else { return }
        selectedConversationId = id
        messages = []
        messagesNumItems = 50
        resubscribeMessages(id: id)
    }

    private func resubscribeMessages(id: String) {
        let args: [String: ConvexEncodable?] = [
            "conversationId": id,
            "numItems": messagesNumItems,
        ]
        messagesSub = convex
            .subscribe(to: "conversations:listMessages", with: args)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] result in
                    if case .failure(let err) = result {
                        self?.errorMessage = err.localizedDescription
                    }
                },
                receiveValue: { [weak self] (result: MessagesResult) in
                    self?.messages = result.messages
                    self?.messagesHasMore = result.hasMore
                }
            )
    }

    func loadMoreMessages() {
        guard let id = selectedConversationId else { return }
        messagesNumItems += 50
        resubscribeMessages(id: id)
    }

    private func resubscribeSelfSummary() {
        selfSummarySub = convex
            .subscribe(to: "users:getSelfSummary", with: [:] as [String: ConvexEncodable?])
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { _ in },
                receiveValue: { [weak self] (result: SelfSummaryResult) in
                    self?.selfSummary = result.selfSummary ?? ""
                    if let ts = result.selfSummaryUpdatedAt {
                        self?.selfSummaryUpdatedAt = Date(timeIntervalSince1970: ts / 1000)
                    }
                }
            )
    }

    func saveSelfSummary(_ text: String) {
        selfSummarySaving = true
        Task {
            do {
                let args: [String: ConvexEncodable?] = ["text": text]
                try await convex.mutation("users:updateSelfSummary", with: args)
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
            }
            await MainActor.run { selfSummarySaving = false }
        }
    }
}
