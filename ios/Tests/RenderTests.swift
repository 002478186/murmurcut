import AVFoundation
import XCTest
@testable import Murmurcut

/// Renders a real project through the same compositor the app uses. Point MURMURCUT_SAMPLE at a folder holding a
/// phone project (video.mov + project.json); without it the test is skipped.
final class RenderTests: XCTestCase {
    func testRealProjectExports() async throws {
        guard let dir = ProcessInfo.processInfo.environment["MURMURCUT_SAMPLE"].map(URL.init(fileURLWithPath:)) else { throw XCTSkip("no sample") }
        var p = try XCTUnwrap(Project.load(Data(contentsOf: dir.appendingPathComponent("project.json"))))
        p.id = UUID()
        try FileManager.default.createDirectory(at: p.folder, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: p.video)
        try FileManager.default.createSymbolicLink(at: p.video, withDestinationURL: dir.appendingPathComponent("video.mov"))
        defer { p.delete() }
        let song = dir.appendingPathComponent("song.m4a")
        if !FileManager.default.fileExists(atPath: song.path) { // a sound-only file, as music from Files would be
            let e = try XCTUnwrap(AVAssetExportSession(asset: AVURLAsset(url: dir.appendingPathComponent("video.mov")), presetName: AVAssetExportPresetAppleM4A))
            e.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: 20, preferredTimescale: 600))
            try await e.export(to: song, as: .m4a)
        }
        try FileManager.default.createSymbolicLink(at: p.folder.appendingPathComponent("song.m4a"), withDestinationURL: song)
        for change in [{ (_: inout Project) in }, { $0.cutPauses = true; $0.cutFillers = true; $0.fit = true; $0.preset = "Editorial" },
                       { $0.speed = 1.5; $0.filter = "Cinematic"; $0.turns = 1; $0.mirror = true; $0.trimIn = 0.1; $0.trimOut = 0.5 },
                       { $0.music = "song.m4a"; $0.texts = [Overlay(text: "Making keys at Walmart", start: 0, end: 5)]; $0.quality = 720 },
                       { // two clips (the second one the 20 s song's video twin), a deleted part, transitions and a new background
                           $0.clips = [Clip(file: "video.mov", duration: $0.duration), Clip(file: "video.mov", duration: $0.duration)]
                           $0.duration *= 2
                           $0 = $0.rearranged([1, 0])
                           $0.removed = [[2, 5]]; $0.transition = "Fade"; $0.transitionOnCuts = true; $0.background = "Blur"; $0.trimIn = 0.48
                       }] {
            var q = p
            change(&q)
            let edit = try await Edit(q)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
            let session = try XCTUnwrap(AVAssetExportSession(asset: edit.composition, presetName: AVAssetExportPreset1280x720))
            session.videoComposition = edit.videoComposition(q)
            session.audioMix = edit.audioMix
            session.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: min(8, q.outputDuration), preferredTimescale: 600))
            try await session.export(to: out, as: .mp4)
            let made = AVURLAsset(url: out)
            XCTAssertEqual(edit.audioMix.inputParameters.count, q.music == nil ? 1 : 2)
            let length = try await made.load(.duration).seconds, sound = try await made.loadTracks(withMediaType: .audio)
            XCTAssertEqual(length, min(8, q.outputDuration), accuracy: 0.2)
            XCTAssertFalse(sound.isEmpty, "export has no sound")
            try? FileManager.default.removeItem(at: out)
        }
    }
}
