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
    @ObservedObject private var aiStore = AIProviderStore.shared
    @State private var searchText = ""
    @State private var selectedSection: SidebarSection = .conversations
    @State private var sidebarVisible: Bool = true
    @State private var selfSummaryText: String = ""
    @State private var selfSummaryLoaded = false
    @ObservedObject private var connectorsVM = ConnectorsViewModel.shared
    @State private var connectorSearchText = ""

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
                modelPickerButton
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

    private var modelPickerButton: some View {
        Menu {
            Section("Google") {
                providerButton("Gemini 2.5 Flash", provider: .google(model: "gemini-2.5-flash"))
                providerButton("Gemini 2.5 Pro",   provider: .google(model: "gemini-2.5-pro"))
                providerButton("Gemini 2.0 Flash", provider: .google(model: "gemini-2.0-flash"))
            }
            Section("Anthropic") {
                providerButton("Claude Sonnet 4.6", provider: .anthropic(model: "claude-sonnet-4-6"))
                providerButton("Claude Opus 4.7",   provider: .anthropic(model: "claude-opus-4-7"))
                providerButton("Claude Haiku 4.5",  provider: .anthropic(model: "claude-haiku-4-5-20251001"))
            }
            Section("OpenAI") {
                providerButton("GPT-4o",      provider: .openai(model: "gpt-4o"))
                providerButton("GPT-4o Mini", provider: .openai(model: "gpt-4o-mini"))
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.system(size: 11, weight: .medium))
                Text(aiStore.chatProvider.shortName)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundColor(.primary.opacity(0.75))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private func providerButton(_ title: String, provider: ChatProvider) -> some View {
        Button {
            aiStore.setProvider(provider)
        } label: {
            HStack {
                Text(title)
                if aiStore.chatProvider.rawValue == provider.rawValue {
                    Spacer()
                    Image(systemName: "checkmark")
                }
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

    private var filteredConnectorApps: [ComposioApp] {
        guard !connectorSearchText.isEmpty else { return connectorsVM.apps }
        return connectorsVM.apps.filter {
            $0.name.localizedCaseInsensitiveContains(connectorSearchText) ||
            $0.slug.localizedCaseInsensitiveContains(connectorSearchText)
        }
    }

    private var connectorsPanel: some View {
        VStack(spacing: 0) {
            panelToolbar(title: "Connectors") {
                if connectorsVM.isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 28, height: 28)
                } else {
                    ToolbarIconButton(icon: "arrow.clockwise") {
                        Task { await connectorsVM.refreshConnections() }
                    }
                    .help("Refresh connections")
                }
            }

            Divider().opacity(0.5)

            // Search bar
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                    .font(.system(size: 13))
                TextField("Search connectors…", text: $connectorSearchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                if !connectorSearchText.isEmpty {
                    Button { connectorSearchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            )
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 10)

            if connectorsVM.apps.isEmpty && !connectorsVM.isLoading {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 36, weight: .light))
                        .foregroundColor(.secondary)
                    Text("No connectors available")
                        .font(.system(size: 15, weight: .medium))
                    Text("Check that your Composio API key is configured.")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 260)
                }
                Spacer()
            } else if filteredConnectorApps.isEmpty {
                Spacer()
                Text("No results for '\(connectorSearchText)'")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 160, maximum: 200), spacing: 12)],
                        spacing: 12
                    ) {
                        ForEach(filteredConnectorApps) { app in
                            ConnectorCard(
                                app: app,
                                isConnected: connectorsVM.connectedAppSlugs.contains(app.slug.lowercased()),
                                isConnecting: connectorsVM.connectingAppKey == app.slug
                            ) {
                                Task {
                                    if let url = await connectorsVM.initiateConnection(appSlug: app.slug) {
                                        NSWorkspace.shared.open(url)
                                    }
                                }
                            } onDisconnect: {
                                Task {
                                    if let conn = connectorsVM.connections.first(where: {
                                        $0.appSlug.lowercased() == app.slug.lowercased()
                                    }) {
                                        await connectorsVM.disconnect(connection: conn)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: .infinity)
                }
            }

            if connectorsVM.hasConnections {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 11))
                        .foregroundColor(.accentColor)
                    Text("Claude will use your connected apps when you chat.")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(Color.accentColor.opacity(0.05))
            }
        }
        .task {
            if connectorsVM.apps.isEmpty {
                await connectorsVM.load()
            }
        }
        .alert("Error", isPresented: Binding(
            get: { connectorsVM.errorMessage != nil },
            set: { if !$0 { connectorsVM.errorMessage = nil } }
        )) {
            Button("OK") { connectorsVM.errorMessage = nil }
        } message: {
            Text(connectorsVM.errorMessage ?? "")
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

// MARK: - Connector card

private struct ConnectorCard: View {
    let app: ComposioApp
    let isConnected: Bool
    let isConnecting: Bool
    let onConnect: () -> Void
    let onDisconnect: () -> Void

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                appIcon
                Spacer()
                if isConnected {
                    connectedBadge
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(app.name.isEmpty ? app.slug.capitalized : app.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                if let desc = app.description, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 0)

            actionButton
        }
        .padding(14)
        .frame(height: 160)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    isConnected ? Color.accentColor.opacity(0.4) : Color.primary.opacity(0.07),
                    lineWidth: isConnected ? 1 : 0.5
                )
        )
        .shadow(color: Color.black.opacity(isHovered ? 0.08 : 0.03), radius: isHovered ? 8 : 4, x: 0, y: 2)
        .onHover { isHovered = $0 }
    }

    private var appIcon: some View {
        Group {
            if let logoStr = app.logo, let url = URL(string: logoStr) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(width: 40, height: 40)
                    default:
                        fallbackIcon
                    }
                }
                .frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                fallbackIcon
            }
        }
    }

    private var fallbackIcon: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.primary.opacity(0.08))
            .frame(width: 40, height: 40)
            .overlay(
                Text(String((app.name.isEmpty ? app.slug : app.name).prefix(1)).uppercased())
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.secondary)
            )
    }

    private var connectedBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(Color.green)
                .frame(width: 5, height: 5)
            Text("Connected")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.green)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.green.opacity(0.1))
        )
    }

    @ViewBuilder
    private var actionButton: some View {
        if isConnecting {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text("Connecting…")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity)
        } else if isConnected {
            HStack(spacing: 0) {
                HStack(spacing: 5) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                    Text("Active")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.green)
                }
                Spacer(minLength: 0)
                Button(action: onDisconnect) {
                    Text("Remove")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Disconnect this app")
            }
            .frame(maxWidth: .infinity)
        } else {
            Button(action: onConnect) {
                Text("Connect")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.black)
                    )
            }
            .buttonStyle(.plain)
        }
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
