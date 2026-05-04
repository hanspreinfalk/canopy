//
//  MainView.swift
//  canopy
//

import ClerkKit
import SwiftUI

enum SidebarSection {
    case conversations
    case memories
    case selfSummary
    case connectors
}

private enum Layout {
    /// Horizontal space reserved on the LEFT of any toolbar row for macOS's
    /// traffic lights. macOS places them at roughly x=20 with ~14pt spacing
    /// between each — so the rightmost light's right edge is around x=72.
    static let trafficLightClearance: CGFloat = 76

    /// Vertical position of the traffic lights' center.
    /// macOS draws them with their center near y=20 from the window top.
    /// We make our toolbar tall enough that 28pt buttons line up with them.
    static let titlebarHeight: CGFloat = 40

    static let sidebarWidth: CGFloat = 256
    static let sidebarInset: CGFloat = 10
}

struct MainView: View {
    @StateObject private var vm = MainViewModel()
    @State private var searchText = ""
    @State private var selectedSection: SidebarSection = .conversations
    @State private var sidebarVisible: Bool = true
    @State private var selfSummaryText: String = ""
    @State private var selfSummaryLoaded = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            backgroundLayer
                .ignoresSafeArea()

            HStack(spacing: 0) {
                if sidebarVisible {
                    Color.clear.frame(width: Layout.sidebarWidth + Layout.sidebarInset * 2)
                }
                rightPanel
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if sidebarVisible {
                sidebar
                    .frame(width: Layout.sidebarWidth)
                    .padding(.leading, Layout.sidebarInset)
                    .padding(.top, Layout.sidebarInset)
                    .padding(.bottom, Layout.sidebarInset)
                    .transition(
                        .asymmetric(
                            insertion: .move(edge: .leading).combined(with: .opacity),
                            removal: .move(edge: .leading).combined(with: .opacity)
                        )
                    )
            }
        }
        .background(TrafficLightPositioner(
            topPadding: sidebarVisible ? 12 : 8,
            leftPadding: sidebarVisible ? 16 : 10
        ).frame(width: 0, height: 0))
        .frame(minWidth: 760, minHeight: 520)
        .ignoresSafeArea(.all, edges: .top)
        .alert("Error", isPresented: Binding(
            get: { vm.errorMessage != nil },
            set: { if !$0 { vm.errorMessage = nil } }
        )) {
            Button("OK") { vm.errorMessage = nil }
        } message: {
            Text(vm.errorMessage ?? "")
        }
    }

    private var backgroundLayer: some View {
        LinearGradient(
            colors: [
                Color(NSColor.windowBackgroundColor),
                Color(NSColor.windowBackgroundColor).opacity(0.96)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            // Top row: traffic-light clearance on the left, collapse button on the FAR RIGHT.
            HStack(spacing: 0) {
                Spacer().frame(width: Layout.trafficLightClearance)
                Spacer()
                ToolbarIconButton(icon: "sidebar.left") {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        sidebarVisible = false
                    }
                }
            }
            .frame(height: Layout.titlebarHeight)
            .padding(.horizontal, 8)
            .padding(.top, 4)

            // Search
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                    .font(.system(size: 13))
                TextField("Search", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            )
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 10)

            // Navigation
            VStack(spacing: 1) {
                SidebarStaticRow(
                    systemImage: "brain.head.profile",
                    title: "Memories",
                    isSelected: selectedSection == .memories
                ) {
                    selectedSection = .memories
                    vm.selectedConversationId = nil
                }
                SidebarStaticRow(
                    systemImage: "person.text.rectangle",
                    title: "Self Summary",
                    isSelected: selectedSection == .selfSummary
                ) {
                    selectedSection = .selfSummary
                    vm.selectedConversationId = nil
                }
                SidebarStaticRow(
                    systemImage: "point.3.connected.trianglepath.dotted",
                    title: "Connectors",
                    isSelected: selectedSection == .connectors
                ) {
                    selectedSection = .connectors
                    vm.selectedConversationId = nil
                }
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 10)

            // Recents
            if !vm.conversations.isEmpty {
                Text("Recents")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)

                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(filteredConversations) { conversation in
                            SidebarRow(
                                conversation: conversation,
                                isSelected: selectedSection == .conversations
                                    && vm.selectedConversationId == conversation.id
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selectedSection = .conversations
                                vm.selectConversation(conversation.id)
                            }
                        }
                        if vm.conversationsHasMore {
                            Button("Load more…") { vm.loadMoreConversations() }
                                .buttonStyle(.borderless)
                                .foregroundColor(.accentColor)
                                .font(.system(size: 12))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 8)
                }
            } else {
                Spacer()
                Text("No conversations yet")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity)
            }

            Spacer(minLength: 0)

            Divider().opacity(0.4)

            SidebarUserRow()
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .background(liquidGlassBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.5), lineWidth: 0.5)
                .blendMode(.overlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.black.opacity(0.06), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 24, x: 0, y: 8)
        .shadow(color: Color.black.opacity(0.04), radius: 2, x: 0, y: 1)
    }

    private var liquidGlassBackground: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.30),
                                Color.white.opacity(0.05)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .blendMode(.overlay)
            )
    }

    private var filteredConversations: [ConvexConversation] {
        guard !searchText.isEmpty else { return vm.conversations }
        return vm.conversations.filter {
            $0.displayTitle.localizedCaseInsensitiveContains(searchText)
        }
    }

    // MARK: - Right panel router

    @ViewBuilder
    private var rightPanel: some View {
        switch selectedSection {
        case .conversations:
            chatPanel
        case .memories:
            memoriesPanel
        case .selfSummary:
            selfSummaryPanel
        case .connectors:
            connectorsPanel
        }
    }

    /// Shared toolbar. When the sidebar is collapsed, traffic lights live in the
    /// right panel, so we add the clearance + sidebar-show button at the start.
    @ViewBuilder
    private func panelToolbar<Trailing: View>(
        title: String,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) -> some View {
        HStack(spacing: 8) {
            if !sidebarVisible {
                Spacer().frame(width: Layout.trafficLightClearance)
                ToolbarIconButton(icon: "sidebar.left") {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        sidebarVisible = true
                    }
                }
                Spacer().frame(width: 4)
            }

            titlePill(title)
            Spacer()
            trailing()
        }
        .frame(height: Layout.titlebarHeight)
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    // MARK: - Chat panel

    private var chatPanel: some View {
        VStack(spacing: 0) {
            panelToolbar(title: chatPanelTitle) {
                ToolbarIconButton(icon: "square.and.arrow.up") {}
                ToolbarIconButton(icon: "square.on.square") {}
            }

            if vm.selectedConversationId != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 24) {
                            if vm.messagesHasMore {
                                Button("Load earlier messages…") { vm.loadMoreMessages() }
                                    .buttonStyle(.borderless)
                                    .foregroundColor(.accentColor)
                                    .font(.system(size: 12))
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 8)
                            }
                            ForEach(vm.messages) { msg in
                                ChatMessageRow(message: msg)
                                    .id(msg.id)
                            }
                            Color.clear.frame(height: 24)
                        }
                        .padding(.horizontal, 32)
                        .padding(.vertical, 20)
                        .frame(maxWidth: 720)
                        .frame(maxWidth: .infinity)
                    }
                    .onChange(of: vm.messages.count) { _ in
                        if let last = vm.messages.last {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                }
            } else {
                Spacer()
                Text("Select a conversation")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            }
        }
    }

    private var chatPanelTitle: String {
        if let selId = vm.selectedConversationId,
           let conv = vm.conversations.first(where: { $0.id == selId }) {
            return conv.displayTitle
        }
        return "Canopy"
    }

    // MARK: - Memories panel (UNTOUCHED)

    private var memoriesPanel: some View {
        VStack(spacing: 0) {
            panelToolbar(title: "Memories")

            Divider().opacity(0.5)

            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(hardcodedMemories) { memory in
                        MemoryCard(memory: memory)
                    }
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 20)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var hardcodedMemories: [MemoryItem] {
        [
            MemoryItem(icon: "swift", label: "Tech stack",
                       text: "Builds macOS apps with Swift and SwiftUI. Uses Convex as the backend and ClerkKit for authentication."),
            MemoryItem(icon: "laptopcomputer", label: "Current project",
                       text: "Working on Canopy — a native macOS AI assistant with a floating pill UI and full conversation history."),
            MemoryItem(icon: "paintbrush.pointed", label: "Design taste",
                       text: "Prefers clean, minimal UI inspired by ChatGPT and Linear. Dislikes heavy chrome or unnecessary dividers."),
            MemoryItem(icon: "globe", label: "Languages",
                       text: "Speaks English and Spanish fluently."),
            MemoryItem(icon: "person.circle", label: "Name",
                       text: "Hans Preinfalk — email hans.preinfalk.davila@gmail.com."),
        ]
    }

    // MARK: - Self Summary panel

    private var selfSummaryPanel: some View {
        VStack(spacing: 0) {
            panelToolbar(title: "Self Summary") {
                Button(action: { vm.saveSelfSummary(selfSummaryText) }) {
                    Group {
                        if vm.selfSummarySaving {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        } else {
                            Text("Save")
                                .font(.system(size: 13, weight: .medium))
                        }
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.black)
                    )
                }
                .buttonStyle(.plain)
                .disabled(vm.selfSummarySaving)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextEditor(text: $selfSummaryText)
                        .font(.system(size: 15))
                        .lineSpacing(5)
                        .scrollContentBackground(.hidden)
                        .background(Color.clear)
                        .contentMargins(.all, 0, for: .scrollContent)  // zero out the internal padding
                        .frame(minHeight: 300)
                        .overlay(alignment: .topLeading) {
                            if selfSummaryText.isEmpty {
                                Text("Describe yourself…")
                                    .font(.system(size: 15))
                                    .foregroundColor(.secondary)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }

                    if let updatedAt = vm.selfSummaryUpdatedAt {
                        Text("Last saved \(updatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                            .padding(.leading, 5)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.top, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            if !selfSummaryLoaded && !vm.selfSummary.isEmpty {
                selfSummaryText = vm.selfSummary
                selfSummaryLoaded = true
            }
        }
        .onChange(of: vm.selfSummary) { newValue in
            if !selfSummaryLoaded {
                selfSummaryText = newValue
                selfSummaryLoaded = true
            }
        }
    }

    // MARK: - Connectors panel

    private var connectorsPanel: some View {
        VStack(spacing: 0) {
            panelToolbar(title: "Connectors")

            Spacer()
            VStack(spacing: 12) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 36, weight: .light))
                    .foregroundColor(.secondary)
                Text("No connectors yet")
                    .font(.system(size: 15, weight: .medium))
                Text("Connect apps and services to extend Canopy's capabilities.")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 260)
            }
            Spacer()
        }
    }

    // MARK: - Title pill

    private func titlePill(_ title: String) -> some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.primary)
                .lineLimit(1)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.04), radius: 4, x: 0, y: 1)
    }
}

// MARK: - Traffic light positioner

private struct TrafficLightPositioner: NSViewRepresentable {
    let topPadding: CGFloat
    let leftPadding: CGFloat

    func makeNSView(context: Context) -> NSView { PositionerView(topPadding: topPadding, leftPadding: leftPadding) }
    func updateNSView(_ nsView: NSView, context: Context) {
        guard let v = nsView as? PositionerView else { return }
        v.topPadding = topPadding
        v.leftPadding = leftPadding
        v.reposition()
    }

    final class PositionerView: NSView {
        var topPadding: CGFloat
        var leftPadding: CGFloat

        init(topPadding: CGFloat, leftPadding: CGFloat) {
            self.topPadding = topPadding
            self.leftPadding = leftPadding
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            reposition()
        }

        func reposition() {
            guard let window,
                  let closeBtn = window.standardWindowButton(.closeButton),
                  let group = closeBtn.superview,
                  let titlebar = group.superview else { return }
            let y = titlebar.frame.height - topPadding - group.frame.height
            group.setFrameOrigin(NSPoint(x: leftPadding, y: y))
        }
    }
}

// MARK: - Toolbar icon button

private struct ToolbarIconButton: View {
    let icon: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.primary.opacity(0.75))
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(isHovered ? Color.primary.opacity(0.06) : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Memory model + card

struct MemoryItem: Identifiable {
    let id = UUID()
    let icon: String
    let label: String
    let text: String
}

private struct MemoryCard: View {
    let memory: MemoryItem

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: memory.icon)
                .font(.system(size: 14, weight: .regular))
                .foregroundColor(.secondary)
                .frame(width: 20, height: 20)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                Text(memory.label.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
                Text(memory.text)
                    .font(.system(size: 13))
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5)
        )
    }
}

// MARK: - Sidebar user row

private struct SidebarUserRow: View {
    var body: some View {
        let user = Clerk.shared.user
        HStack(spacing: 10) {
            if let imageUrl = user?.imageUrl, let url = URL(string: imageUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        initialsCircle(for: user)
                    }
                }
                .frame(width: 28, height: 28)
                .clipShape(Circle())
            } else {
                initialsCircle(for: user)
            }
            Text(displayName(for: user))
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.primary)
                .lineLimit(1)
            Spacer()
        }
    }

    private func displayName(for user: User?) -> String {
        let first = user?.firstName ?? ""
        let last = user?.lastName ?? ""
        let full = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
        if !full.isEmpty { return full }
        return user?.primaryEmailAddress?.emailAddress ?? "Account"
    }

    private func initials(for user: User?) -> String {
        let f = user?.firstName?.prefix(1) ?? ""
        let l = user?.lastName?.prefix(1) ?? ""
        let s = "\(f)\(l)"
        return s.isEmpty ? "?" : s.uppercased()
    }

    private func initialsCircle(for user: User?) -> some View {
        Circle()
            .fill(Color.orange)
            .frame(width: 28, height: 28)
            .overlay(
                Text(initials(for: user))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
            )
    }
}

// MARK: - Static sidebar row

private struct SidebarStaticRow: View {
    let systemImage: String
    let title: String
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 13))
                    .foregroundColor(.primary)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.primary)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(rowBackground)
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    private var rowBackground: Color {
        if isSelected { return Color.primary.opacity(0.08) }
        if isHovered  { return Color.primary.opacity(0.04) }
        return .clear
    }
}

// MARK: - Sidebar conversation row

private struct SidebarRow: View {
    let conversation: ConvexConversation
    let isSelected: Bool
    @State private var isHovered = false

    var body: some View {
        HStack {
            Text(conversation.displayTitle)
                .font(.system(size: 13))
                .foregroundColor(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(rowBackground)
        )
        .onHover { isHovered = $0 }
    }

    private var rowBackground: Color {
        if isSelected { return Color.primary.opacity(0.08) }
        if isHovered  { return Color.primary.opacity(0.04) }
        return .clear
    }
}

// MARK: - Chat message row

private struct ChatMessageRow: View {
    let message: ConvexMessage

    private var isUser: Bool { message.role == "user" }
    private var content: String { message.textContent.isEmpty ? "—" : message.textContent }

    private var timestamp: String {
        let date = message.creationDate
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser {
                Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(content)
                        .font(.system(size: 14))
                        .foregroundColor(.primary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Capsule().fill(Color.primary.opacity(0.07)))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(timestamp)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .padding(.trailing, 4)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(content)
                        .font(.system(size: 14))
                        .foregroundColor(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(timestamp)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }
        }
    }
}
