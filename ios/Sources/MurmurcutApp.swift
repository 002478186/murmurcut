import SwiftUI

@main
struct MurmurcutApp: App {
    @State private var url: URL?
    @State private var failure: String?

    var body: some Scene {
        WindowGroup {
            ZStack {
                Color.black.ignoresSafeArea()
                if let url {
                    WebView(url: url)
                } else {
                    Text(failure ?? "").foregroundStyle(.white).padding()
                }
            }
            .preferredColorScheme(.dark)
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in DebugLog.add("iOS memory warning") }
            .task {
                UIApplication.shared.isIdleTimerDisabled = true // captioning and export run for minutes; don't lock mid-way
                DebugLog.add("app started, iOS \(UIDevice.current.systemVersion)")
                LocalServer.shared.onPost = Captions.handle
                do { url = try await LocalServer.shared.start() } catch { failure = "Couldn't start murmurcut: \(error.localizedDescription)" }
            }
        }
    }
}
