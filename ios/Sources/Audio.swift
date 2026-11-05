import AVFoundation
import AudioToolbox

/// Sound work done ahead of time: cleaning up the voice.
enum Voice {
    /// The video's sound with the background taken out (Apple's on-device voice isolation), written to `out` as AAC. The
    /// isolator's delay is trimmed off the front, so the voice stays in sync with the lips.
    static func enhance(_ video: URL, to out: URL) async throws {
        let sound = try await Captions.soundOnly(video)
        defer { try? FileManager.default.removeItem(at: sound) }
        let input = try AVAudioFile(forReading: sound)
        let format = input.processingFormat
        let isolate = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_AUSoundIsolation,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        engine.attach(player)
        engine.attach(isolate)
        engine.connect(player, to: isolate, format: format)
        engine.connect(isolate, to: engine.mainMixerNode, format: format)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        try engine.start()
        defer { engine.stop() }
        player.scheduleFile(input, at: nil, completionHandler: nil)
        player.play()

        try? FileManager.default.removeItem(at: out)
        let output = try AVAudioFile(forWriting: out, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: format.sampleRate,
                                                                  AVNumberOfChannelsKey: format.channelCount, AVEncoderBitRateKey: 192_000])
        guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096) else { throw Captions.Failure(errorDescription: "Couldn't hold the sound in memory") }
        var skip = AVAudioFramePosition((isolate.auAudioUnit.latency * format.sampleRate).rounded())
        let total = input.length + skip
        while engine.manualRenderingSampleTime < total {
            let n = AVAudioFrameCount(min(4096, total - engine.manualRenderingSampleTime))
            guard try engine.renderOffline(n, to: buffer) == .success else { continue }
            let drop = min(skip, AVAudioFramePosition(buffer.frameLength))
            skip -= drop
            if drop == AVAudioFramePosition(buffer.frameLength) { continue }
            if drop > 0 { // move the samples after the delay to the front of the buffer
                for c in 0..<Int(format.channelCount) {
                    let a = buffer.floatChannelData![c]
                    a.update(from: a + Int(drop), count: Int(buffer.frameLength) - Int(drop))
                }
                buffer.frameLength -= AVAudioFrameCount(drop)
            }
            try output.write(from: buffer)
        }
        DebugLog.add("voice: enhanced \(Int(Double(input.length) / format.sampleRate)) s, delay \(isolate.auAudioUnit.latency) s")
    }
}
