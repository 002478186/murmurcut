import AVFoundation
import Photos
import SwiftUI

/// Renders the edit to an MP4, saves it to Photos and offers it (and its captions as .srt) to share.
struct ExportView: View {
    let project: Project
    @State private var progress = 0.0
    @State private var file: URL?
    @State private var saved = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 22) {
            ZStack {
                Circle().stroke(Theme.raised, lineWidth: 10)
                Circle().trim(from: 0, to: progress).stroke(Theme.brand, style: StrokeStyle(lineWidth: 10, lineCap: .round)).rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.2), value: progress)
                if file != nil {
                    Image(systemName: "checkmark").font(.system(size: 44, weight: .bold)).foregroundStyle(Theme.brand).transition(.scale)
                } else {
                    Text("\(Int(progress * 100))%").font(.title.monospacedDigit().bold())
                }
            }
            .frame(width: 140, height: 140)
            .padding(.top, 28)

            Text(failure ?? (file == nil ? "Exporting your video…" : saved ? "Saved to Photos" : "Ready")).font(.title3.bold()).multilineTextAlignment(.center)
            if file == nil && failure == nil {
                Text("Keep murmurcut open until it's done.").font(.subheadline).foregroundStyle(Theme.muted)
            }
            if let file {
                ShareLink(item: file) { Label("Share video", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }
                    .buttonStyle(BrandButton())
                if !project.words.isEmpty {
                    ShareLink(item: srt()) { Label("Captions file (.srt)", systemImage: "captions.bubble").frame(maxWidth: .infinity, minHeight: 50) }
                        .font(.headline).background(Theme.raised, in: .capsule).buttonStyle(.plain)
                }
            }
            Spacer()
            Button(file == nil && failure == nil ? "Cancel" : "Done") { dismiss() }.font(.headline).foregroundStyle(Theme.muted)
        }
        .padding(24)
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.bg)
        .interactiveDismissDisabled(file == nil && failure == nil)
        .task { await run() }
    }

    private func run() async {
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = false }
        do {
            let edit = try await Edit(project)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("murmurcut \(Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).timeSeparator(.omitted))).mp4")
            try? FileManager.default.removeItem(at: out)
            guard let session = AVAssetExportSession(asset: edit.composition, presetName: AVAssetExportPresetHighestQuality) else { throw Captions.Failure(errorDescription: "This phone can't export this video") }
            session.videoComposition = edit.videoComposition(project, export: true)
            session.audioMix = edit.audioMix
            session.audioTimePitchAlgorithm = .spectral
            DebugLog.add("export: started, \(String(format: "%.1f", project.outputDuration)) s")
            let watch = Task {
                for await state in session.states(updateInterval: 0.1) { if case .exporting(let p) = state { progress = p.fractionCompleted } }
            }
            try await session.export(to: out, as: .mp4) // cancelled with this view's task when Cancel closes it
            watch.cancel()
            progress = 1
            withAnimation(.spring) { file = out }
            DebugLog.add("export: done, \(String(format: "%.1f", project.outputDuration)) s")
            if await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized {
                try await PHPhotoLibrary.shared().performChanges { PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: out) }
                saved = true
            }
        } catch {
            DebugLog.add("export failed: \(error)")
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }

    private func srt() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("murmurcut captions.srt")
        try? project.srt(maxWords: Preset.named(project.preset).maxWords).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
