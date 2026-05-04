import SwiftUI

@main
struct canopyApp: App {
    @StateObject private var dictation = FnDictationManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(dictation)
        }
        .windowStyle(.plain)
        .windowResizability(.contentSize)
    }
}
