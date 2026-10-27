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
            let words = try await transcribe(video, language: lang)
            reply = ["type": "done", "chunks": words.map { ["text": $0.text, "timestamp": $0.timestamp] }]
        } catch {
            reply = ["type": "error", "message": error.localizedDescription]
        }
        return (try? JSONSerialization.data(withJSONObject: reply)) ?? Data()
    }

    static func transcribe(_ video: URL, language: String) async throws -> [Word] {
        guard #available(iOS 26, *) else { throw Failure(errorDescription: "Apple captions need iOS 26") }
        _ = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
        let audio = try await soundOnly(video)
        defer { try? FileManager.default.removeItem(at: audio) }
        let ids = (locales[language] ?? []).map(Locale.init(identifier:))
        // SpeechTranscriber is the newer, better model; DictationTranscriber covers more languages (Hindi among them).
        for id in ids {
            if let locale = await SpeechTranscriber.supportedLocale(equivalentTo: id) {
                let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
                return words(from: try await run(t, t.results.map(\.text), audio), romanize: language == "hindi")
            }
        }
        for id in ids {
            if let locale = await DictationTranscriber.supportedLocale(equivalentTo: id) {
                let t = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [.audioTimeRange])
                return words(from: try await run(t, t.results.map(\.text), audio), romanize: language == "hindi")
            }
        }
        throw Failure(errorDescription: "Apple has no on-device \(language) captions")
    }

    /// Every timed run of text as (text, start, end), downloading the language model the first time.
    @available(iOS 26, *)
    static func run<S: AsyncSequence>(_ module: any SpeechModule, _ texts: S, _ audio: URL) async throws -> [(String, Double, Double)] where S.Element == AttributedString {
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [module]) { try await install.downloadAndInstall() }
        let analyzer = SpeechAnalyzer(modules: [module])
        let collect = Task {
            var runs: [(String, Double, Double)] = []
            for try await text in texts {
                for run in text.runs { if let r = run.audioTimeRange { runs.append((String(text[run.range].characters), r.start.seconds, r.end.seconds)) } }
            }
            return runs
        }
        if let last = try await analyzer.analyzeSequence(from: try AVAudioFile(forReading: audio)) {
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
