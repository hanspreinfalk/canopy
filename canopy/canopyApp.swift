//
//  canopyApp.swift
//  canopy
//
//  Created by Hans Preinfalk on 5/3/26.
//

import SwiftUI

@main
struct canopyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    
    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
