import AVFoundation
import Speech

/// Captions from Apple's on-device speech recognition, so the phone doesn't run Whisper inside the web page (which is what
/// runs it out of memory). Answers POST /native/transcribe?lang=hindi&ext=mov with the same JSON the Whisper worker sends.
enum Captions {
    struct Word: Encodable, Equatable { let text: String; let timestamp: [Double] }
    struct Failure: LocalizedError { let errorDescription: String? }

    // The web app's language names -> locales to try, best first.
    static let locales = [
        "english": ["en-IN", "en-US", "en-GB"], "hindi": ["hi-IN"], "spanish": ["es-ES", "es-MX"], "french": ["fr-FR"],
        "german": ["de-DE"], "portuguese": ["pt-BR", "pt-PT"], "italian": ["it-IT"], "japanese": ["ja-JP"], "korean": ["ko-KR"],
        "chinese": ["zh-CN"], "arabic": ["ar-SA"], "russian": ["ru-RU"], "urdu": ["ur-PK", "ur-IN"], "bengali": ["bn-IN", "bn-BD"],
    ]

    static func handle(path: String, body: URL) async -> Data {
        let query = URLComponents(string: path)?.queryItems ?? []
        let lang = query.first { $0.name == "lang" }?.value ?? "english"
        let ext = query.first { $0.name == "ext" }?.value ?? "mov"
        let video = body.appendingPathExtension(ext) // AVFoundation goes by the extension
        let reply: [String: Any]
        do {
            try FileManager.default.moveItem(at: body, to: video)
            defer { try? FileManager.default.removeItem(at: video) }
            let size = (try? video.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            DebugLog.add("captions: got \(size >> 20) MB .\(ext), language \(lang)")
            let words = try await transcribe(video, language: lang)
            DebugLog.add("captions: done, \(words.count) words, \(words.first?.timestamp[0] ?? 0)s to \(words.last?.timestamp[1] ?? 0)s:\(words.map(\.text).joined())")
            reply = ["type": "done", "chunks": words.map { ["text": $0.text, "timestamp": $0.timestamp] }]
        } catch {
            DebugLog.add("captions: failed: \(error)")
            reply = ["type": "error", "message": error.localizedDescription]
        }
        return (try? JSONSerialization.data(withJSONObject: reply)) ?? Data()
    }

    static func transcribe(_ video: URL, language: String) async throws -> [Word] {
        guard #available(iOS 26, *) else { throw Failure(errorDescription: "Apple captions need iOS 26") }
        _ = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
        let audio = try await soundOnly(video)
        defer { try? FileManager.default.removeItem(at: audio) }
        // The last captioned sound stays in Documents next to the log, so a bad transcript can be checked against it.
        let keep = DebugLog.url.deletingLastPathComponent().appendingPathComponent("last-captions.m4a")
        try? FileManager.default.removeItem(at: keep)
        try? FileManager.default.copyItem(at: audio, to: keep)
        DebugLog.add("captions: sound is \(Int(AVURLAsset(url: audio).duration.seconds))s")
        let ids = (locales[language] ?? []).map(Locale.init(identifier:))
        var dictation: Locale?
        for id in ids where dictation == nil { dictation = await DictationTranscriber.supportedLocale(equivalentTo: id) }
        let dictate = { (locale: Locale) in
            DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [.audioTimeRange])
        }
        // SpeechTranscriber is the newer, better model; DictationTranscriber covers more languages (Hindi among them).
        var first: [(String, Double, Double)]?
        for id in ids where first == nil {
            if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: id) {
                let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
                first = try await run(t, t.results.map(\.text), audio)
            }
        }
        if first == nil, let locale = dictation {
            let t = dictate(locale)
            first = try await run(t, t.results.map(\.text), audio)
        }
        guard var runs = first else { throw Failure(errorDescription: "Apple has no on-device \(language) captions") }
        // Quiet or far-off speech gets skipped, so a second pass hears only the gaps, made louder.
        let file = try AVAudioFile(forReading: audio)
        let holes = gaps(in: runs, duration: Double(file.length) / file.processingFormat.sampleRate)
        if !holes.isEmpty, let locale = dictation {
            let t = dictate(locale)
            let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t])
            let loud = try gapsOnly(file, holes, as: best)
            defer { try? FileManager.default.removeItem(at: loud) }
            let more = try await run(t, t.results.map(\.text), loud).filter { r in holes.contains { r.1 >= $0.0 - 0.5 && r.1 < $0.1 } }
            DebugLog.add("captions: second pass over \(holes.count) gaps (\(Int(holes.reduce(0) { $0 + $1.1 - $1.0 }))s) found:\(more.map(\.0).joined())")
            runs = (runs + more).sorted { $0.1 < $1.1 }
        }
        return words(from: runs, romanize: language == "hindi")
    }

    /// Stretches of 3 s or more with no captions, from the start to the end of the sound.
    static func gaps(in runs: [(String, Double, Double)], duration: Double) -> [(Double, Double)] {
        var out: [(Double, Double)] = [], t = 0.0
        for r in runs.sorted(by: { $0.1 < $1.1 }) {
            if r.1 - t >= 3 { out.append((t, r.1)) }
            t = max(t, r.2)
        }
        if duration - t >= 3 { out.append((t, duration)) }
        return out
    }

    /// The sound with everything but the gaps silenced and each gap turned up (up to 20 dB), timed like the original.
    // shortcut: holds the whole sound in memory twice (about 50 MB a minute of stereo); stream it if long videos run out.
    /// Dictation times its words at half speed when it converts the sound itself, so it gets the format it asks for.
    static func gapsOnly(_ file: AVAudioFile, _ gaps: [(Double, Double)], as target: AVAudioFormat?) throws -> URL {
        let format = file.processingFormat, n = Int(file.length)
        guard let src = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)),
              let dst = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else {
            throw Failure(errorDescription: "Couldn't hold the sound in memory")
        }
        file.framePosition = 0
        try file.read(into: src)
        dst.frameLength = src.frameLength
        for c in 0..<Int(format.channelCount) {
            let a = src.floatChannelData![c], b = dst.floatChannelData![c]
            b.update(repeating: 0, count: Int(src.frameLength))
            for (from, to) in gaps {
                let lo = max(0, Int(from * format.sampleRate)), hi = min(Int(src.frameLength), Int(to * format.sampleRate))
                guard lo < hi else { continue }
                var sum: Float = 0
                for i in lo..<hi { sum += a[i] * a[i] }
                let gain = min(10, max(1, 0.1 / max((sum / Float(hi - lo)).squareRoot(), 1e-6))) // towards -20 dB loudness
                for i in lo..<hi { b[i] = max(-1, min(1, a[i] * gain)) }
            }
        }
        var sound = dst
        if let target, target != format, let convert = AVAudioConverter(from: format, to: target),
           let conv = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(dst.frameLength) * target.sampleRate / format.sampleRate) + 4096) {
            var fed = false, error: NSError?
            convert.convert(to: conv, error: &error) { _, status in
                status.pointee = fed ? .endOfStream : .haveData
                defer { fed = true }
                return fed ? nil : dst
            }
            if let error { throw error }
            sound = conv
        }
        DebugLog.add("captions: gap sound is \(sound.format)")
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        do { // the file is finished when it closes, at the end of this block
            let w = try AVAudioFile(forWriting: out, settings: sound.format.settings, commonFormat: sound.format.commonFormat, interleaved: sound.format.isInterleaved)
            try w.write(from: sound)
        }
        return out
    }

    /// Every timed run of text as (text, start, end), downloading the language model the first time.
    @available(iOS 26, *)
    static func run<S: AsyncSequence>(_ module: any SpeechModule, _ texts: S, _ audio: URL) async throws -> [(String, Double, Double)] where S.Element == AttributedString {
        DebugLog.add("captions: using \(type(of: module))")
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            DebugLog.add("captions: downloading the language model")
            try await install.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [module])
        let collect = Task {
            var runs: [(String, Double, Double)] = []
            for try await text in texts {
                for run in text.runs { if let r = run.audioTimeRange { runs.append((String(text[run.range].characters), r.start.seconds, r.end.seconds)) } }
            }
            return runs
        }
        if let last = try await analyzer.analyzeSequence(from: try AVAudioFile(forReading: audio)) {
            DebugLog.add("captions: analyzed to \(last.seconds)s")
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await collect.value
    }

    /// The video's sound as an .m4a, since AVAudioFile can't open most video files.
    static func soundOnly(_ video: URL) async throws -> URL {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
        guard let export = AVAssetExportSession(asset: AVURLAsset(url: video), presetName: AVAssetExportPresetAppleM4A) else {
            throw Failure(errorDescription: "Couldn't read this video's sound")
        }
        try await export.export(to: out, as: .m4a)
        return out
    }

    /// Timed runs -> one caption word each. Runs holding several words share their time by length; punctuation joins the word before.
    static func words(from runs: [(String, Double, Double)], romanize: Bool) -> [Word] {
        var out: [Word] = []
        for (raw, start, end) in runs {
            let parts = raw.split(whereSeparator: \.isWhitespace).map { romanize ? latin(String($0)) : String($0) }
            let total = Double(parts.reduce(0) { $0 + $1.count + 1 })
            var t = start
            for p in parts {
                let d = (end - start) * Double(p.count + 1) / total
                if p.allSatisfy({ $0.isPunctuation }), let last = out.popLast() {
                    out.append(Word(text: last.text + p, timestamp: last.timestamp))
                } else {
                    out.append(Word(text: " " + p, timestamp: [t, t + d]))
                }
                t += d
            }
        }
        return out
    }

    /// Devanagari -> Hinglish spelling, like Whisper gives: नाम -> naam, आज -> aaj, हिंदी -> hindi.
    static func latin(_ word: String) -> String {
        guard var s = word.applyingTransform(.toLatin, reverse: false) else { return word }
        s = s.replacingOccurrences(of: "ā", with: "aa").replacingOccurrences(of: "ṁ", with: "n").replacingOccurrences(of: "ṃ", with: "n")
        s = s.applyingTransform(.stripDiacritics, reverse: false) ?? s
        // Hindi doesn't say the vowel written after a final consonant: नाम is "naam", not "naama".
        if let last = word.unicodeScalars.last?.value, (0x915...0x939).contains(last) || (0x958...0x95F).contains(last), s.hasSuffix("a") {
            s.removeLast()
        }
        return s
    }
}
