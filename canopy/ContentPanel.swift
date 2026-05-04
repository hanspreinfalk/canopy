//
//  ContentPanel.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import AppKit
import SwiftUI

class ContentPanel: NSPanel {
    
    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        
        setupWindow()
        setupContentView()
    }
    
    private func setupWindow() {
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        level = .floating
        isMovableByWindowBackground = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        
        collectionBehavior = [
            .canJoinAllSpaces,
            .stationary
        ]
    }
    
    private func setupContentView() {
        let contentView = ContentView() {
            self.close()
        }

        let hostingView = NSHostingView(rootView: contentView)
        self.contentView = hostingView

        let panelSize = CGSize(width: PillConstants.panelWidth, height: PillConstants.panelHeight)
        setContentSize(panelSize)

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let xPosition = screenFrame.midX - panelSize.width / 2
            let yPosition = screenFrame.minY + PillConstants.bottomPadding

            setFrameOrigin(NSPoint(x: xPosition, y: yPosition))
        }
    }
}
