import AVFoundation
import MetricKit
import SwiftUI

@main
struct MurmurcutApp: App {
    init() {
        // Without this, iOS mutes the preview whenever the ring/silent switch is on.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        MXMetricManager.shared.add(CrashReports.shared)
    }

    var body: some Scene {
        WindowGroup {
            HomeView()
                .preferredColorScheme(.dark)
                .tint(Theme.pink)
                .task { DebugLog.add("app started, iOS \(UIDevice.current.systemVersion)") }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in DebugLog.add("iOS memory warning") }
        }
    }
}

/// iOS hands over the last crash (where it happened, and why) on the next launch; it goes into the log.
final class CrashReports: NSObject, MXMetricManagerSubscriber {
    static let shared = CrashReports()
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for crash in payloads.flatMap({ $0.crashDiagnostics ?? [] }) {
            DebugLog.add("CRASH: \(String(decoding: crash.jsonRepresentation(), as: UTF8.self))")
        }
    }
}

enum Theme {
    static let bg = Color(red: 0.03, green: 0.03, blue: 0.045)
    static let surface = Color(red: 0.085, green: 0.085, blue: 0.11)
    static let raised = Color(red: 0.13, green: 0.13, blue: 0.165)
    static let line = Color.white.opacity(0.08)
    static let muted = Color(red: 0.62, green: 0.62, blue: 0.68)
    static let pink = Color(red: 1, green: 0.24, blue: 0.55)
    static let violet = Color(red: 0.55, green: 0.36, blue: 0.96)
    static let brand = LinearGradient(colors: [pink, violet], startPoint: .leading, endPoint: .trailing)
}

/// The main call to action: a gradient capsule.
struct BrandButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.horizontal, 20).frame(minHeight: 50)
            .background(Theme.brand, in: .capsule)
            .shadow(color: Theme.pink.opacity(0.35), radius: 16, y: 6)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}

/// Chips and secondary buttons: a raised capsule, outlined in the brand colour when selected.
struct Chip: View {
    let title: String
    var icon: String? = nil
    var selected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label { Text(title) } icon: { if let icon { Image(systemName: icon) } }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(selected ? .white : Theme.muted)
                .padding(.horizontal, 14).frame(minHeight: 40)
                .background(selected ? Theme.raised : Theme.surface, in: .capsule)
                .overlay(Capsule().strokeBorder(selected ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.line), lineWidth: selected ? 1.5 : 1))
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: selected)
    }
}
