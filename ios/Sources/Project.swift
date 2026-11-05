import Foundation

struct Word: Codable, Hashable {
    var text: String
    var start, end: Double
    var cut = false
}

/// One caption on screen: a few words, timed on the output (cut) timeline.
struct Line: Hashable {
    var words: [Word]
    var start: Double { words.first!.start }
    var end: Double { words.last!.end }
}

/// One video in the project. The clips play one after another; together they make the source timeline.
struct Clip: Codable, Hashable, Identifiable {
    var id = UUID()
    var file: String // in the project folder
    var duration: Double
}

/// Text placed on the video for a while, like a title.
struct Overlay: Codable, Hashable, Identifiable {
    var id = UUID()
    var text: String
    var start, end: Double // on the output timeline
    var y = 0.22 // centre, as a share of the frame height
    var size = 1.0
    var preset = "Pop"
    var accent = 2
}

/// A picture, GIF or meme shown over the video while a sentence is said.
struct Broll: Codable, Hashable, Identifiable {
    struct Found: Codable, Hashable { var url: String; var credit: String; var gif = false; var about = "" } // about: the picture's title and description
    var id = UUID()
    var start, end: Double // on the output timeline
    var query: String
    var kind = "photo" // photo, gif, meme, or text when nothing was found
    var mode = "full" // full, card, blur
    var file: String? // in the project folder
    var credit = ""
    var options: [Found] = [] // what the search found, for Next
    var pick = 0
}

enum Aspect: String, Codable, CaseIterable {
    case original = "Original", vertical = "9:16", portrait = "4:5", square = "1:1", wide = "16:9"
    var ratio: Double? { ["9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9][rawValue] }
}

/// Everything the user chose about one video. Saved as Documents/Projects/<id>/project.json, next to video.mov.
struct Project: Codable, Identifiable, Hashable {
    var id = UUID()
    var created = Date()
    var duration: Double = 0 // of all the clips together
    var clips: [Clip] = [] // empty: just video.mov, as projects were before clips
    var removed: [[Double]] = [] // source stretches deleted with Split and Delete
    var splits: [Double] = [] // source times where the user split
    var language = UserDefaults.standard.string(forKey: "spokenLanguage") ?? "auto"
    var heard: String? // the language "auto" picked
    var words: [Word] = []
    var captioned = false
    var translation: [Word] = [] // the captions in another language, on the source timeline
    var translatedTo: String? // its language code
    var showTranslation = false
    // Style
    var preset = "Karaoke"
    var size = 1.0
    var position = 0.68 // caption centre, as a share of the frame height
    var accent = 0
    // Cuts
    var cutFillers = false
    var cutPauses = false
    var maxPause = 0.5
    // Format and zoom
    var aspect = Aspect.vertical
    var fit = false
    var punchIns = true
    var zoom = 1.15
    // Edit
    var trimIn = 0.0, trimOut = 1.0 // the kept part of the source, as shares of its length
    var speed = 1.0
    var volume = 1.0
    var turns = 0 // quarter turns clockwise
    var mirror = false
    // Filter and adjustments
    var filter = "Original"
    var filterAmount = 1.0
    var brightness = 0.0, contrast = 1.0, saturation = 1.0, warmth = 0.0, vignette = 0.0, sharpen = 0.0
    // Audio
    var enhanceVoice = false
    var music: String? // file name in the project folder
    var musicVolume = 0.35
    var duck = true // music dips while someone talks
    // Text and export
    var texts: [Overlay] = []
    var brolls: [Broll] = []
    var topicNames: [String] = [] // what the video is about, found by Auto B-roll, for its searches
    var quality = 1080 // the short side of the export, in pixels
    var transition = "None" // between clips
    var transitionOnCuts = false // and at every jump cut
    var background = "Keep" // what shows behind the person

    var folder: URL { Self.root.appendingPathComponent(id.uuidString) }
    var video: URL { folder.appendingPathComponent("video.mov") }
    var thumbnail: URL { folder.appendingPathComponent("thumb.jpg") }
    var reel: [Clip] { clips.isEmpty ? [Clip(file: "video.mov", duration: duration)] : clips }
    func url(_ c: Clip) -> URL { folder.appendingPathComponent(c.file) }
    func cleanVoice(_ c: Clip) -> URL { folder.appendingPathComponent(c.file == "video.mov" ? "voice.m4a" : "voice-\(c.file).m4a") }
    var musicFile: URL? { music.map { folder.appendingPathComponent($0) } }

    static let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Projects")

    static func all() -> [Project] {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return dirs.compactMap { (try? Data(contentsOf: $0.appendingPathComponent("project.json"))).flatMap(load) }
            .sorted { $0.created > $1.created }
    }

    /// Decodes a saved project, filling settings added since it was saved with their defaults.
    static func load(_ data: Data) -> Project? {
        guard let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let base = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(Project())) as? [String: Any],
              let merged = try? JSONSerialization.data(withJSONObject: base.merging(saved) { $1 }) else { return nil }
        return try? JSONDecoder().decode(Project.self, from: merged)
    }

    func save() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? JSONEncoder().encode(self).write(to: folder.appendingPathComponent("project.json"))
    }

    func delete() { try? FileManager.default.removeItem(at: folder) }
}

// MARK: - Edits (pure, unit tested)

extension Project {
    static let fillers: Set<String> = ["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm"]

    static func isFiller(_ w: Word) -> Bool { fillers.contains(w.text.lowercased().trimmingCharacters(in: .punctuationCharacters)) }

    func isCut(_ w: Word) -> Bool { w.cut || (cutFillers && Self.isFiller(w)) }

    /// The parts of the source video that stay, in order, as (start, end) seconds.
    var kept: [(Double, Double)] {
        var removed: [(Double, Double)] = words.filter(isCut).map { ($0.start, $0.end) } + [(0, trimIn * duration), (trimOut * duration, duration)]
            + self.removed.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
        let spoken = words.filter { !isCut($0) }
        if cutPauses && !spoken.isEmpty {
            let pad = 0.12 // breathing room each side of a cut pause, so words don't clip
            let edges = [0.0] + spoken.flatMap { [$0.start, $0.end] } + [duration]
            for i in stride(from: 0, to: edges.count - 1, by: 2) where edges[i + 1] - edges[i] > maxPause {
                removed.append((i == 0 ? 0 : edges[i] + pad, i == edges.count - 2 ? duration : edges[i + 1] - pad))
            }
        }
        var out: [(Double, Double)] = [], t = 0.0
        for (a, b) in removed.sorted(by: { $0.0 < $1.0 }) where b > t {
            if a > t { out.append((t, a)) }
            t = b
        }
        if duration > t { out.append((t, duration)) }
        return out.filter { $0.1 - $0.0 > 0.04 }
    }

    /// The words in sentences, for translating: a sentence ends at . ? !, a pause, or 14 words.
    var sentences: [[Word]] {
        var out: [[Word]] = [], s: [Word] = []
        for w in words where !w.cut {
            if let last = s.last, s.count >= 14 || w.start - last.end > 0.7 || last.text.last.map(".?!।".contains) == true { out.append(s); s = [] }
            s.append(w)
        }
        if !s.isEmpty { out.append(s) }
        return out
    }

    /// A translated sentence as timed words, spread over the time the original took, longer words for longer.
    static func spread(_ text: String, from: Double, to: Double) -> [Word] {
        let parts = text.split(whereSeparator: \.isWhitespace).map(String.init)
        let total = Double(parts.reduce(0) { $0 + $1.count + 1 })
        var t = from
        return parts.map { p in
            let d = (to - from) * Double(p.count + 1) / max(1, total)
            defer { t += d }
            return Word(text: p, start: t, end: t + d)
        }
    }

    /// B-roll moments from scored sentences (output start, end, query, kind, score): the best first, each at least `gap`
    /// seconds from the next and none repeating a query, so the speaker stays on screen between them.
    static func moments(_ cands: [(Double, Double, String, String, Int)], gap: Double = 2.5, length: Double = 2.5) -> [Broll] {
        var picked: [Broll] = []
        for c in cands.sorted(by: { $0.4 > $1.4 }) where c.4 >= 5 && c.0 >= 1 && c.1 - c.0 >= 0.8 {
            let b = Broll(start: c.0 + 0.15, end: min(c.1, c.0 + 0.15 + length), query: c.2, kind: c.3)
            if picked.allSatisfy({ (b.start >= $0.end + gap || b.end + gap <= $0.start) && $0.query.lowercased() != b.query.lowercased() }) { picked.append(b) }
        }
        let modes = ["full", "card", "blur"]
        return picked.sorted { $0.start < $1.start }.enumerated().map { i, b in var b = b; b.mode = b.kind == "photo" ? modes[i % 3] : "card"; return b }
    }

    /// How well a picture's title and description match a search: the share of the search's words found in them (plurals
    /// and case ignored), with a small bonus for each of the video's names it mentions.
    static func match(_ about: String, query: String, names: [String] = []) -> Double {
        func words(_ s: String) -> Set<String> {
            Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map { w in w.count > 3 && w.hasSuffix("s") ? String(w.dropLast()) : String(w) }.filter { $0.count > 1 })
        }
        let have = words(about), want = words(query).subtracting(["the", "and", "of", "a", "with", "in", "on", "for"])
        guard !want.isEmpty else { return 0 }
        let named = names.filter { !words($0).isEmpty && words($0).isSubset(of: have) }.count
        return Double(want.intersection(have).count) / Double(want.count) + 0.25 * Double(named)
    }

    /// Where each clip starts on the source timeline.
    var clipStarts: [Double] { reel.dropLast().reduce(into: [0.0]) { $0.append($0.last! + $1.duration) } }

    /// The source time shown at output time `t` (the inverse of `outputTime`, with speed).
    func sourceTime(_ t: Double) -> Double {
        var left = t * speed
        for (a, b) in kept {
            if left <= b - a { return a + left }
            left -= b - a
        }
        return kept.last?.1 ?? 0
    }

    /// The stretch around source time `t` between splits, clip edges and cuts: what Delete removes.
    func part(at t: Double) -> (Double, Double) {
        let edges = (splits + clipStarts + [duration] + kept.flatMap { [$0.0, $0.1] }).sorted()
        return (edges.last { $0 <= t + 1e-6 } ?? 0, edges.first { $0 > t + 1e-6 } ?? duration)
    }

    /// The clips in a new order, given as old indices; a clip left out is deleted. Words, splits and deleted stretches
    /// move with their clip.
    func rearranged(_ order: [Int]) -> Project {
        let old = reel, oldStarts = clipStarts
        var p = self
        p.clips = order.map { old[$0] }
        p.duration = p.clips.reduce(0) { $0 + $1.duration }
        let newStarts = p.clipStarts
        func move(_ t: Double) -> Double? { // a source time in its clip's new place, nil if that clip went
            guard let k = oldStarts.lastIndex(where: { $0 <= t + 1e-9 }), let j = order.firstIndex(of: k) else { return nil }
            return t - oldStarts[k] + newStarts[j]
        }
        p.words = words.compactMap { w in move(w.start).map { var w = w; w.end = $0 + w.end - w.start; w.start = $0; return w } }.sorted { $0.start < $1.start }
        p.splits = splits.compactMap(move)
        // A deleted stretch can cross into the next clip, so it is cut at clip edges first.
        let edges = oldStarts + [duration]
        p.removed = removed.flatMap { r -> [[Double]] in
            guard r.count == 2 else { return [] }
            return zip(edges, edges.dropFirst()).compactMap { a, b in
                let lo = max(r[0], a), hi = min(r[1], b)
                guard hi > lo, let m = move(lo) else { return nil }
                return [m, m + hi - lo]
            }
        }
        return p
    }

    /// Where a source time lands once the cuts are made, or nil if it was cut.
    static func outputTime(_ t: Double, kept: [(Double, Double)]) -> Double? {
        var before = 0.0
        for (a, b) in kept {
            if t < a { return nil }
            if t <= b { return before + t - a }
            before += b - a
        }
        return nil
    }

    /// Kept words in caption lines on the output timeline. A line breaks at a sentence end, a pause, or `maxWords`.
    func lines(maxWords: Int) -> [Line] {
        let keep = kept
        var lines: [Line] = [], line: [Word] = []
        for w in (showTranslation && !translation.isEmpty ? translation : words) where !isCut(w) {
            guard let s = Self.outputTime(w.start, kept: keep).map({ $0 / speed }) else { continue }
            let moved = Word(text: w.text, start: s, end: s + (w.end - w.start) / speed)
            if let last = line.last, line.count >= maxWords || moved.start - last.end > 0.3 || last.text.last.map(".?!".contains) == true {
                lines.append(Line(words: line))
                line = []
            }
            line.append(moved)
        }
        if !line.isEmpty { lines.append(Line(words: line)) }
        return lines
    }

    /// Where someone is talking on the output timeline, joined across short breaths: where music dips.
    var speech: [(Double, Double)] {
        var out: [(Double, Double)] = []
        for l in lines(maxWords: 8) {
            if let last = out.last, l.start - last.1 < 0.8 { out[out.count - 1].1 = max(last.1, l.end) } else { out.append((l.start, l.end)) }
        }
        return out
    }

    var outputDuration: Double { kept.reduce(0) { $0 + $1.1 - $1.0 } / speed }

    func srt(maxWords: Int) -> String {
        func stamp(_ t: Double) -> String {
            let ms = Int((t * 1000).rounded())
            return String(format: "%02d:%02d:%02d,%03d", ms / 3_600_000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000)
        }
        return lines(maxWords: maxWords).enumerated().map { i, l in
            "\(i + 1)\n\(stamp(l.start)) --> \(stamp(l.end))\n\(l.words.map(\.text).joined(separator: " "))\n"
        }.joined(separator: "\n")
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
