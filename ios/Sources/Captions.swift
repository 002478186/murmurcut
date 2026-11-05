import AVFoundation
import Speech

/// Captions from Apple's on-device speech recognition: every spoken word with its start and end in seconds.
enum Captions {
    struct Failure: LocalizedError { let errorDescription: String? }

    // Language names -> locales to try, best first.
    static let locales = [
        "english": ["en-IN", "en-US", "en-GB"], "hindi": ["hi-IN"], "spanish": ["es-ES", "es-MX"], "french": ["fr-FR"],
        "german": ["de-DE"], "portuguese": ["pt-BR", "pt-PT"], "italian": ["it-IT"], "japanese": ["ja-JP"], "korean": ["ko-KR"],
        "chinese": ["zh-CN"], "arabic": ["ar-SA"], "russian": ["ru-RU"], "urdu": ["ur-PK", "ur-IN"], "bengali": ["bn-IN", "bn-BD"],
    ]

    /// Language codes -> our names, for "auto".
    static let codes = ["en": "english", "hi": "hindi", "es": "spanish", "fr": "french", "de": "german", "pt": "portuguese", "it": "italian",
                        "ja": "japanese", "ko": "korean", "zh": "chinese", "ar": "arabic", "ru": "russian", "ur": "urdu", "bn": "bengali"]

    /// The words, and the language they were heard in ("auto" picks one).
    static func transcribe(_ video: URL, language: String) async throws -> (words: [Word], language: String) {
        _ = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
        let audio = try await soundOnly(video)
        defer { try? FileManager.default.removeItem(at: audio) }
        let language = language == "auto" ? try await detect(audio) : language
        // The last captioned sound stays in Documents next to the log, so a bad transcript can be checked against it.
        let keep = DebugLog.url.deletingLastPathComponent().appendingPathComponent("last-captions.m4a")
        try? FileManager.default.removeItem(at: keep)
        try? FileManager.default.copyItem(at: audio, to: keep)
        DebugLog.add("captions: sound is \(Int(AVURLAsset(url: audio).duration.seconds))s")
        let ids = (locales[language] ?? []).map(Locale.init(identifier:))
        var speech: Locale?, dictation: Locale?
        for id in ids where speech == nil { speech = await SpeechTranscriber.supportedLocale(equivalentTo: id) }
        for id in ids where dictation == nil { dictation = await DictationTranscriber.supportedLocale(equivalentTo: id) }
        // SpeechTranscriber is the newer, better model (and writes Hindi in Latin letters, as Hinglish); DictationTranscriber
        // covers more languages. Both passes use the best one there is.
        let speechModule = speech.map { l in { SpeechTranscriber(locale: l, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange]) } }
        let dictationModule = dictation.map { l in { DictationTranscriber(locale: l, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [.audioTimeRange]) } }
        func hear(_ url: URL, speech: Bool) async throws -> [(String, Double, Double)] {
            if speech, let make = speechModule { let t = make(); return try await run(t, t.results.map(\.text), url).map { ($0.0, $0.1, $0.2) } }
            if let make = dictationModule { let t = make(); return try await run(t, t.results.map(\.text), url).map { ($0.0, $0.1, $0.2) } }
            return []
        }
        guard speechModule != nil || dictationModule != nil else { throw Failure(errorDescription: "Apple has no on-device \(language) captions") }
        // Heard as a whole, a long file comes back with most of its words missing (quiet or far-off speech gets skipped), so
        // it is heard in short pieces, each made louder: first with the better model, then whatever stays silent with
        // Dictation, which hears more but writes Hindi in Devanagari.
        var runs: [(String, Double, Double)] = []
        let file = try AVAudioFile(forReading: audio)
        for useSpeech in [true, false] where useSpeech ? speechModule != nil : dictationModule != nil {
            let holes = gaps(in: runs, duration: Double(file.length) / file.processingFormat.sampleRate)
            if holes.isEmpty { break }
            let probe: any SpeechModule = useSpeech ? speechModule!() : dictationModule!()
            let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
            var more: [(String, Double, Double)] = []
            for (from, to) in pieces(of: holes) {
                // Each piece reaches half a second past both ends, so a word on the join is heard whole, by the piece it starts in.
                let start = max(0, from - 0.5)
                let clip = try gapClip(file, from: start, to: to + 0.5, as: best)
                defer { try? FileManager.default.removeItem(at: clip) }
                let heard = try await hear(clip, speech: useSpeech).map { ($0.0, $0.1 + start, $0.2 + start) }.filter { $0.1 >= from - 0.05 && $0.1 < to }
                DebugLog.add("captions: \(String(format: "%.1f-%.1f", from, to)) heard:\(heard.map { String(format: " [%.1f]", $0.1) + $0.0 }.joined())")
                more += heard
            }
            DebugLog.add("captions: \(useSpeech ? "speech" : "dictation") pass over \(holes.count) gaps (\(Int(holes.reduce(0) { $0 + $1.1 - $1.0 }))s) found:\(more.map(\.0).joined())")
            runs = (runs + more).sorted { $0.1 < $1.1 }
        }
        return (words(from: runs, romanize: language == "hindi"), language)
    }

    /// The spoken language: the first minute heard in English, Hindi and the phone's own languages; the one the recognizer is
    /// surest of wins, English on a near tie. Hindi words in the Hindi transcript count for Hindi, so Hinglish lands there
    /// (and comes out in Latin letters).
    static func detect(_ audio: URL) async throws -> String {
        var names = ["english", "hindi"]
        for id in Locale.preferredLanguages {
            if let name = Locale(identifier: id).language.languageCode.flatMap({ codes[$0.identifier] }), !names.contains(name) { names.append(name) }
        }
        let file = try AVAudioFile(forReading: audio)
        var best = ("english", -1.0)
        for name in names {
            var locale: Locale?
            for id in locales[name] ?? [] where locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) }
            guard let locale else { continue }
            let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange, .transcriptionConfidence])
            let clip = try gapClip(file, from: 0, to: min(60, Double(file.length) / file.processingFormat.sampleRate),
                                   as: await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]))
            defer { try? FileManager.default.removeItem(at: clip) }
            let heard = try await run(module, module.results.map(\.text), clip)
            let letters = heard.reduce(0) { $0 + Double($1.0.count) }
            var score = letters == 0 ? 0 : heard.reduce(0) { $0 + $1.3 * Double($1.0.count) } / letters
            let text = heard.map(\.0).joined()
            if name == "hindi" {
                let said = text.lowercased().split { !$0.isLetter }.filter { hindiWords.contains(String($0)) }.count
                score += min(0.3, 0.05 * Double(said))
            }
            DebugLog.add("captions: \(name) scores \(String(format: "%.2f", score)): \(text.prefix(80))")
            if score > best.1 + (best.0 == "english" ? 0.02 : 0) { best = (name, score) }
        }
        return best.0
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

    /// Gaps cut into pieces of at most 8 s, so each one is heard fresh (longer pieces lose more words).
    static func pieces(of gaps: [(Double, Double)]) -> [(Double, Double)] {
        gaps.flatMap { gap -> [(Double, Double)] in
            let n = max(1, Int(((gap.1 - gap.0) / 8).rounded(.up))), step = (gap.1 - gap.0) / Double(n)
            return (0..<n).map { (gap.0 + Double($0) * step, gap.0 + Double($0 + 1) * step) }
        }
    }

    /// One stretch of the sound as its own file starting at 0, turned up (up to 20 dB) and in the format Dictation asks for:
    /// it times its words at half speed when it converts the sound itself.
    static func gapClip(_ file: AVAudioFile, from: Double, to: Double, as target: AVAudioFormat?) throws -> URL {
        let format = file.processingFormat
        let lo = AVAudioFramePosition(from * format.sampleRate), n = AVAudioFrameCount(max(0, min(Double(file.length), to * format.sampleRate) - Double(lo)))
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { throw Failure(errorDescription: "Couldn't hold the sound in memory") }
        file.framePosition = lo
        try file.read(into: buf, frameCount: n)
        let len = Int(buf.frameLength)
        for c in 0..<Int(format.channelCount) {
            let a = buf.floatChannelData![c]
            var sum: Float = 0
            for i in 0..<len { sum += a[i] * a[i] }
            let gain = min(10, max(1, 0.1 / max((sum / Float(max(1, len))).squareRoot(), 1e-6))) // towards -20 dB loudness
            for i in 0..<len { a[i] = max(-1, min(1, a[i] * gain)) }
        }
        var sound = buf
        if let target, target != format, let convert = AVAudioConverter(from: format, to: target),
           let conv = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(len) * target.sampleRate / format.sampleRate) + 4096) {
            var fed = false, error: NSError?
            convert.convert(to: conv, error: &error) { _, status in
                status.pointee = fed ? .endOfStream : .haveData
                defer { fed = true }
                return fed ? nil : buf
            }
            if let error { throw error }
            sound = conv
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        do { // the file is finished when it closes, at the end of this block
            let w = try AVAudioFile(forWriting: out, settings: sound.format.settings, commonFormat: sound.format.commonFormat, interleaved: sound.format.isInterleaved)
            try w.write(from: sound)
        }
        return out
    }

    /// Every timed run of text as (text, start, end, confidence 0-1), downloading the language model the first time.
    static func run<S: AsyncSequence>(_ module: any SpeechModule, _ texts: S, _ audio: URL) async throws -> [(String, Double, Double, Double)] where S.Element == AttributedString {
        DebugLog.add("captions: using \(type(of: module))")
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            DebugLog.add("captions: downloading the language model")
            try await install.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [module])
        let collect = Task {
            var runs: [(String, Double, Double, Double)] = []
            for try await text in texts {
                for run in text.runs {
                    if let r = run.audioTimeRange { runs.append((String(text[run.range].characters), r.start.seconds, r.end.seconds, run.transcriptionConfidence ?? 1)) }
                }
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
                    out.append(Word(text: last.text + p, start: last.start, end: last.end))
                } else {
                    out.append(Word(text: p, start: t, end: t + d))
                }
                t += d
            }
        }
        return out
    }

    /// Devanagari -> Hinglish, spelt the way people type it: आपके -> aapke, क्या -> kya, शादी -> shaadi, में -> mein.
    static func latin(_ word: String) -> String {
        let base = word.trimmingCharacters(in: .punctuationCharacters.union(.init(charactersIn: "।"))), tail = word.hasSuffix("।") ? "." : String(word.dropFirst(base.count))
        if let w = common[base] { return w + tail }
        guard var s = base.applyingTransform(.toLatin, reverse: false), s != base else { return word }
        // Hindi doesn't say the vowel written after a final consonant (नाम is "naam"), nor one between two syllables (करने is "karne").
        if let last = base.unicodeScalars.last?.value, (0x915...0x939).contains(last) || (0x958...0x95F).contains(last), s.hasSuffix("a") { s.removeLast() }
        s = s.replacing(schwa) { String($0.output.1 + $0.output.2) }
        if s.count > 2, s.hasSuffix("ā") { s = s.dropLast() + "a" } // गया -> gaya
        for (from, to) in [("ēṁ", "ein"), ("ṁ", "n"), ("ṃ", "n"), ("m̐", "n"), ("ā'ī", "ai"), ("ā'ē", "aaye"), ("a'ē", "aye"), ("'", ""),
                           ("ā", "aa"), ("ś", "sh"), ("ṣ", "sh"), ("ch", "\u{1}"), ("c", "ch"), ("\u{1}", "chh")] {
            s = s.replacingOccurrences(of: from, with: to)
        }
        return (s.applyingTransform(.stripDiacritics, reverse: false) ?? s) + tail
    }

    /// The vowel-consonant-a-consonant-vowel pattern whose "a" Hindi drops.
    nonisolated(unsafe) static let schwa = try! Regex("([aāiīuūeoēō][^aāiīuūeoēō\\s']h?)a([^aāiīuūeoēō\\s']h?)(?=[aāiīuūeoēō])", as: (Substring, Substring, Substring).self)

    /// Hindi's commonest words as Hinglish, which English speech almost never has.
    static let hindiWords: Set<String> = ["hai", "hain", "ka", "ki", "ke", "ko", "se", "mein", "main", "nahi", "nahin", "kya", "aur", "toh", "hum",
                                          "aap", "yeh", "woh", "bhi", "tha", "thi", "raha", "rahe", "rahi", "karenge", "kar", "karo", "dosto", "log", "kaise", "accha", "achha", "bhai", "haan", "matlab"]

    /// Everyday words whose Hinglish spelling no rule gets right.
    static let common = ["यह": "yeh", "वह": "woh", "हम": "hum", "तो": "toh", "मैं": "main", "हूँ": "hoon", "हूं": "hoon", "हाँ": "haan", "हां": "haan",
                         "नहीं": "nahi", "ठीक": "theek", "अच्छा": "achha", "चीज़": "cheez", "चीज": "cheez", "क्यों": "kyun", "भी": "bhi", "ही": "hi"]
}
