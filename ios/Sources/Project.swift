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

enum Aspect: String, Codable, CaseIterable {
    case original = "Original", vertical = "9:16", portrait = "4:5", square = "1:1", wide = "16:9"
    var ratio: Double? { ["9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9][rawValue] }
}

/// Everything the user chose about one video. Saved as Documents/Projects/<id>/project.json, next to video.mov.
struct Project: Codable, Identifiable, Hashable {
    var id = UUID()
    var created = Date()
    var duration: Double = 0
    var language = UserDefaults.standard.string(forKey: "spokenLanguage") ?? "auto"
    var heard: String? // the language "auto" picked
    var words: [Word] = []
    var captioned = false
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
    var quality = 1080 // the short side of the export, in pixels

    var folder: URL { Self.root.appendingPathComponent(id.uuidString) }
    var video: URL { folder.appendingPathComponent("video.mov") }
    var thumbnail: URL { folder.appendingPathComponent("thumb.jpg") }
    var cleanVoice: URL { folder.appendingPathComponent("voice.m4a") }
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
        for w in words where !isCut(w) {
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
