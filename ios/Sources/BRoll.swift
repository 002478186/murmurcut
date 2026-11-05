import CoreImage
import FoundationModels
import ImageIO
import NaturalLanguage
import UIKit

/// Automatic B-roll: what each sentence is about, a picture for the best moments, and drawing them over the video.
enum BRoll {
    // MARK: Planning

    @Generable struct Pick {
        @Guide(description: "What the sentence means, in plain English") var meaning: String
        @Guide(description: "photo for a thing, place or person; gif for an action or reaction; meme for a joke, surprise or strong feeling") var kind: String
        @Guide(description: "2 to 4 English words naming a concrete thing you can photograph (an object, a place, a brand, someone doing something), as you'd type into an image search") var query: String
        @Guide(description: "How much a visual would help here, 0 to 10", .range(0...10)) var score: Int
    }
    @Generable struct Plan { @Guide(description: "One entry per sentence, in order") var picks: [Pick] }
    @Generable struct Topic {
        @Guide(description: "What the whole video is about, in a few English words, naming it exactly (the game, product, place, dish or person)") var subject: String
        @Guide(description: "The proper names that matter most in the video, as they're spelt in English", .maximumCount(5)) var names: [String]
    }

    /// What the whole video is about, so each sentence's search can name it.
    static func topic(_ text: String, model: SystemLanguageModel) async -> Topic? {
        let session = LanguageModelSession(model: model, instructions: "You read the transcript of a talking video. It may be Hinglish (Hindi in Latin letters).")
        do { return try await session.respond(to: "Transcript:\n" + String(text.prefix(3500)), generating: Topic.self).content } catch {
            DebugLog.add("broll: couldn't find the topic: \(error)")
            return nil
        }
    }

    /// The moments worth a visual, with what to search for. Apple's on-device model reads the sentences (Hinglish too);
    /// without it, the strongest noun of each sentence is used.
    static func plan(_ p: Project) async -> (moments: [Broll], names: [String]) {
        let keep = p.kept
        let sentences = p.sentences.compactMap { s -> (String, Double, Double)? in
            guard let a = Project.outputTime(s.first!.start, kept: keep), let b = Project.outputTime(s.last!.end, kept: keep) ?? Project.outputTime(s.last!.start, kept: keep) else { return nil }
            return (s.map(\.text).joined(separator: " "), a / p.speed, b / p.speed)
        }
        var cands: [(Double, Double, String, String, Int)] = [], names: [String] = [], subject = ""
        if case .available = SystemLanguageModel.default.availability {
            // The user's own words are being reworded, so the gentler content filter applies; a batch it still refuses is
            // retried a sentence at a time, so one flagged line doesn't cost the rest.
            let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
            let about = await topic(sentences.map(\.0).joined(separator: " "), model: model)
            names = about?.names ?? []
            subject = about?.subject ?? ""
            DebugLog.add("broll: the video is about \(subject), names \(names)")
            let context = about.map { "The whole video is about \($0.subject). When a sentence is about it, name it in the query (\($0.names.joined(separator: ", "))), so the picture shows exactly that, not something generic. " } ?? ""
            func ask(_ batch: [(String, Double, Double)]) async -> [Pick]? {
                let session = LanguageModelSession(model: model, instructions: "You pick B-roll for a talking video. Sentences may be Hinglish (Hindi in Latin letters); understand their meaning. Search queries are always English: one short phrase, no commas. " + context)
                let prompt = "Sentences:\n" + batch.enumerated().map { "\($0.offset + 1). \($0.element.0)" }.joined(separator: "\n")
                do { return try await session.respond(to: prompt, generating: Plan.self).content.picks } catch {
                    DebugLog.add("broll: the on-device model refused \(batch.count) sentences: \(error)")
                    return nil
                }
            }
            for batch in stride(from: 0, to: sentences.count, by: 12).map({ Array(sentences[$0..<min($0 + 12, sentences.count)]) }) {
                var picks = await ask(batch)
                if picks == nil {
                    var one: [Pick] = []
                    for s in batch { if let p = await ask([s])?.first { one.append(p) } else { one.append(Pick(meaning: "", kind: "photo", query: strongestNoun(s.0) ?? "", score: 0)) } }
                    picks = one
                }
                DebugLog.add("broll: picks \((picks ?? []).map { "\($0.score) \($0.kind) \($0.query)" })")
                for (s, k) in zip(batch, picks ?? []) where !k.query.isEmpty {
                    // A list ("key, Canada, metal") searches for all of it and finds nothing; its first two parts make a phrase.
                    let query = k.query.split(separator: ",").prefix(2).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
                    cands.append((s.1, s.2, query, ["gif", "meme"].contains(k.kind) ? k.kind : "photo", k.score))
                }
            }
            DebugLog.add("broll: the on-device model read \(sentences.count) sentences")
        }
        if cands.isEmpty {
            for s in sentences { if let noun = strongestNoun(s.0) { cands.append((s.1, s.2, noun, "photo", 6)) } }
            DebugLog.add("broll: no on-device model, used nouns from \(sentences.count) sentences")
        }
        return (Project.moments(cands), (names + [subject]).filter { !$0.isEmpty })
    }

    /// Whether the query names something (a place, a company, a person), which Wikipedia has a picture of.
    static func isName(_ query: String) -> Bool {
        let tagger = NLTagger(tagSchemes: [.nameType])
        tagger.string = query
        var found = false
        tagger.enumerateTags(in: query.startIndex..<query.endIndex, unit: .word, scheme: .nameType, options: [.omitWhitespace, .joinNames]) { tag, _ in
            found = found || [.placeName, .organizationName, .personalName].contains(tag)
            return !found
        }
        return found
    }

    static func strongestNoun(_ text: String) -> String? {
        let tagger = NLTagger(tagSchemes: [.lexicalClass, .nameType])
        tagger.string = text
        var names: [String] = [], nouns: [String] = []
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: [.omitWhitespace, .omitPunctuation, .joinNames]) { tag, r in
            if [.placeName, .organizationName, .personalName].contains(tag) { names.append(String(text[r])) }
            return true
        }
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .lexicalClass, options: [.omitWhitespace, .omitPunctuation]) { tag, r in
            if tag == .noun, text[r].count > 3 { nouns.append(String(text[r])) }
            return true
        }
        return names.first ?? nouns.max { $0.count < $1.count }
    }

    // MARK: Finding pictures

    static let agent = "murmurcut/1.0 (iPhone video editor)"
    static var giphyKey: String { UserDefaults.standard.string(forKey: "giphyKey")?.trimmingCharacters(in: .whitespaces) ?? "" }
    static var pexelsKey: String { UserDefaults.standard.string(forKey: "pexelsKey")?.trimmingCharacters(in: .whitespaces) ?? "" }

    /// A JSON reply. The query is given as pairs and encoded once: a hand-encoded URL with a "|" in it gets encoded
    /// again by URL(string:), turning every %20 into %2520, and the search comes back empty.
    static func json(_ base: String, _ query: KeyValuePairs<String, String>, headers: [String: String] = [:]) async throws -> [String: Any] {
        guard var parts = URLComponents(string: base) else { return [:] }
        parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let u = parts.url else { return [:] }
        var r = URLRequest(url: u, timeoutInterval: 10)
        r.setValue(agent, forHTTPHeaderField: "User-Agent")
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        let (data, reply) = try await URLSession.shared.data(for: r)
        if let h = reply as? HTTPURLResponse, h.statusCode != 200 { throw Captions.Failure(errorDescription: "The search failed (\(h.statusCode))") }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// Wikipedia knows named things (Walmart, Mumbai); Commons has everyday things; both are freely licensed.
    static func wikipedia(_ query: String) async -> [Broll.Found] {
        let d = try? await json("https://en.wikipedia.org/w/api.php", ["action": "query", "format": "json", "generator": "search", "gsrlimit": "4", "prop": "pageimages",
                                                                        "piprop": "thumbnail|name", "pithumbsize": "960", "gsrsearch": query])
        let pages = ((d?["query"] as? [String: Any])?["pages"] as? [String: [String: Any]] ?? [:]).values.sorted { ($0["index"] as? Int ?? 0) < ($1["index"] as? Int ?? 0) }
        return pages.compactMap { p in
            guard let src = (p["thumbnail"] as? [String: Any])?["source"] as? String, let name = p["pageimage"] as? String else { return nil }
            let page = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
            return Broll.Found(url: src, credit: "\"\(p["title"] as? String ?? query)\" via Wikimedia Commons: https://commons.wikimedia.org/wiki/File:\(page)", about: p["title"] as? String ?? "")
        }
    }

    static func commons(_ query: String, gif: Bool) async -> [Broll.Found] {
        let filter = gif ? "filemime:image/gif" : "filemime:image/jpeg"
        let d = try? await json("https://commons.wikimedia.org/w/api.php", ["action": "query", "format": "json", "generator": "search", "gsrnamespace": "6", "gsrlimit": "8",
                                                                            "gsrsearch": query + " " + filter, "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": "960"])
        let pages = ((d?["query"] as? [String: Any])?["pages"] as? [String: [String: Any]] ?? [:]).values.sorted { ($0["index"] as? Int ?? 0) < ($1["index"] as? Int ?? 0) }
        return pages.compactMap { p in
            guard let info = (p["imageinfo"] as? [[String: Any]])?.first, let src = (info["thumburl"] ?? info["url"]) as? String else { return nil }
            let meta = info["extmetadata"] as? [String: [String: Any]] ?? [:]
            let artist = (meta["Artist"]?["value"] as? String ?? "unknown").replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            let licence = meta["LicenseShortName"]?["value"] as? String ?? ""
            let description = (meta["ImageDescription"]?["value"] as? String ?? "").replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            let title = (p["title"] as? String ?? "").replacingOccurrences(of: "File:", with: "")
            return Broll.Found(url: src, credit: "\(title) by \(artist), \(licence), via Wikimedia Commons: \(info["descriptionurl"] as? String ?? "")", gif: gif, about: title + " " + description.prefix(300))
        }
    }

    static func giphy(_ query: String) async -> [Broll.Found] {
        guard !giphyKey.isEmpty, let d = try? await json("https://api.giphy.com/v1/gifs/search", ["api_key": giphyKey, "q": query, "limit": "8", "rating": "pg-13"]) else { return [] }
        return (d["data"] as? [[String: Any]] ?? []).compactMap { g in
            guard let url = ((g["images"] as? [String: Any])?["downsized"] as? [String: Any])?["url"] as? String else { return nil }
            return Broll.Found(url: url, credit: "\"\(g["title"] as? String ?? query)\" via GIPHY: \(g["url"] as? String ?? "")", gif: true, about: (g["title"] as? String ?? "") + " " + (g["alt_text"] as? String ?? ""))
        }
    }

    static func pexels(_ query: String) async -> [Broll.Found] {
        guard !pexelsKey.isEmpty, let d = try? await json("https://api.pexels.com/v1/search", ["query": query, "per_page": "8"], headers: ["Authorization": pexelsKey]) else { return [] }
        return (d["photos"] as? [[String: Any]] ?? []).compactMap { p in
            guard let src = (p["src"] as? [String: Any])?["large"] as? String else { return nil }
            return Broll.Found(url: src, credit: "Photo by \(p["photographer"] as? String ?? "unknown") on Pexels: \(p["url"] as? String ?? "")", about: p["alt"] as? String ?? "")
        }
    }

    /// Everything a moment could show, the closest matches first; pictures that match none of the search's words are
    /// dropped. When nothing matches, a picture of the video's subject stands in, which beats an unrelated one.
    static func search(_ query: String, kind: String, names: [String] = []) async -> [Broll.Found] {
        // The search as said, then shorter: without the video's names, its last two words, its strongest noun; then the
        // names themselves. "Ghost of Yotei katana sword fight" has no free pictures, "sword fight" does.
        let words = query.split(separator: " ").map(String.init)
        let bare = words.filter { w in !names.contains { $0.localizedCaseInsensitiveContains(w) } }.joined(separator: " ")
        var tries = [query, bare, words.suffix(2).joined(separator: " "), strongestNoun(query) ?? ""] + names
        tries = tries.filter { !$0.isEmpty }.reduce(into: [String]()) { if !$0.contains($1.lowercased()) { $0.append($1.lowercased()) } }
        for (i, q) in tries.enumerated() {
            let ranked = rank(await find(q, kind: i == 0 ? kind : "photo", names: names), query: q, names: names)
            if !ranked.isEmpty {
                if i > 0 { DebugLog.add("broll: nothing matched \"\(query)\", showing \"\(q)\"") }
                return ranked
            }
        }
        return []
    }

    /// Matching pictures, best first. GIPHY and Pexels results count as matches unless another source matches better,
    /// since their titles are short.
    static func rank(_ found: [Broll.Found], query: String, names: [String]) -> [Broll.Found] {
        let scored = found.enumerated().map { (i, f) in (f, Project.match(f.about, query: query, names: names) + (f.credit.contains("GIPHY") || f.credit.contains("Pexels") ? 0.3 : 0), i) }
        return scored.filter { $0.1 > 0.3 }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }.map(\.0)
    }

    static func find(_ query: String, kind: String, names: [String] = []) async -> [Broll.Found] {
        async let gifs = kind == "photo" ? [] : giphy(kind == "meme" ? query + " meme" : query)
        // Wikipedia only for names (Walmart, Mumbai): for ideas it answers with whichever article mentions the words.
        async let named = isName(query) || names.contains(where: { query.localizedCaseInsensitiveContains($0) }) ? wikipedia(query) : []
        async let free = commons(query, gif: false)
        async let stock = pexels(query)
        return await gifs + stock + named + free
    }

    /// Downloads the moment's current pick into the project, skipping ones that fail. Nothing found makes it a text card.
    static func fetch(_ b: Broll, into folder: URL, avoiding used: Set<String> = []) async -> Broll {
        var b = b
        // The first option no other moment shows: one picture four times looks broken.
        if let fresh = b.options.indices.first(where: { !used.contains(b.options[$0].url) }) { b.pick = fresh }
        for _ in 0..<min(4, b.options.count) {
            let o = b.options[b.pick % b.options.count]
            if let url = URL(string: o.url), let (data, _) = try? await URLSession.shared.data(for: { var r = URLRequest(url: url, timeoutInterval: 15); r.setValue(agent, forHTTPHeaderField: "User-Agent"); return r }()),
               CGImageSourceCreateWithData(data as CFData, nil).map(CGImageSourceGetCount) ?? 0 > 0 {
                let name = "broll-\(b.id.uuidString.prefix(8))-\(b.pick).\(o.gif ? "gif" : "jpg")"
                if (try? data.write(to: folder.appendingPathComponent(name))) != nil {
                    if let old = b.file, old != name { try? FileManager.default.removeItem(at: folder.appendingPathComponent(old)) }
                    b.file = name; b.credit = o.credit
                    if b.kind == "text" { b.kind = o.gif ? "gif" : "photo" }
                    return b
                }
            }
            b.pick = (b.pick + 1) % b.options.count
        }
        if b.file == nil { b.kind = "text"; b.mode = "full" }
        return b
    }

    // MARK: Drawing

    /// Decoded pictures (every frame of a GIF), so playback never waits on a file.
    final class Pictures: @unchecked Sendable {
        static let shared = Pictures()
        private var cache: [String: ([CIImage], [Double])] = [:]
        private let lock = NSLock()

        func frames(_ url: URL) -> ([CIImage], [Double]) {
            lock.lock(); defer { lock.unlock() }
            if let hit = cache[url.path] { return hit }
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return ([], []) }
            var images: [CIImage] = [], delays: [Double] = []
            for i in 0..<min(80, CGImageSourceGetCount(src)) { // a long GIF is cut at 80 frames
                guard let cg = CGImageSourceCreateImageAtIndex(src, i, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { continue }
                images.append(CIImage(cgImage: cg))
                let gif = (CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any])?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
                delays.append(max(0.03, (gif?[kCGImagePropertyGIFUnclampedDelayTime] ?? gif?[kCGImagePropertyGIFDelayTime]) as? Double ?? 0.1))
            }
            cache[url.path] = (images, delays)
            return (images, delays)
        }
    }

    static func picture(_ b: Broll, folder: URL, age: Double) -> CIImage? {
        guard let file = b.file else { return nil }
        let (images, delays) = Pictures.shared.frames(folder.appendingPathComponent(file))
        guard !images.isEmpty else { return nil }
        guard images.count > 1 else { return images[0] }
        var t = age.truncatingRemainder(dividingBy: delays.reduce(0, +))
        for (i, d) in delays.enumerated() { if t < d { return images[i] }; t -= d }
        return images.last
    }

    /// The moment playing at `t` laid over `frame` (already in place, `size` big, origin bottom-left).
    static func draw(_ b: Broll, over frame: CIImage, at t: Double, folder: URL, size R: CGSize) -> CIImage {
        let age = t - b.start, alpha = min(1, age / 0.2, (b.end - t) / 0.2)
        guard alpha > 0 else { return frame }
        let box = CGRect(origin: .zero, size: R)
        func fade(_ i: CIImage) -> CIImage { i.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: alpha)]) }
        func fit(_ i: CIImage, into r: CGRect, cover: Bool, zoom: Double = 1) -> CIImage {
            let e = i.extent, k = (cover ? max(r.width / e.width, r.height / e.height) : min(r.width / e.width, r.height / e.height)) * zoom
            return i.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(.init(scaleX: k, y: k))
                .concatenating(.init(translationX: r.midX - e.width * k / 2, y: r.midY - e.height * k / 2)))
        }
        let blurred = frame.clampedToExtent().applyingGaussianBlur(sigma: 30).applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.5]).cropped(to: box)
        guard let pic = picture(b, folder: folder, age: age) else { return fade(blurred).composited(over: frame) } // a text card: the keyword is drawn with the captions
        switch b.mode {
        case "card":
            let w = R.width * 0.74, h = min(R.height * 0.42, w * pic.extent.height / pic.extent.width)
            let pop = 0.86 + 0.14 * Captioner.backOut(min(1, age / 0.22)), border = R.width * 0.012
            let card = CGRect(x: (R.width - w) / 2, y: R.height * 0.66 - h / 2, width: w, height: h)
            let photo = fit(pic, into: card, cover: true).cropped(to: card)
            let frameBox = CIImage(color: .white).cropped(to: card.insetBy(dx: -border, dy: -border))
            let shadow = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.45)).cropped(to: card.insetBy(dx: -border * 2, dy: -border * 2)).applyingGaussianBlur(sigma: R.width * 0.02)
            var layer = photo.composited(over: frameBox).composited(over: shadow)
            let c = CGPoint(x: card.midX, y: card.midY)
            layer = layer.transformed(by: CGAffineTransform(translationX: -c.x, y: -c.y).concatenating(.init(rotationAngle: -0.025)).concatenating(.init(scaleX: pop, y: pop)).concatenating(.init(translationX: c.x, y: c.y)))
            return fade(layer.cropped(to: box)).composited(over: frame)
        case "blur":
            return fade(fit(pic, into: box.insetBy(dx: R.width * 0.08, dy: R.height * 0.18), cover: false).composited(over: blurred)).composited(over: frame)
        default: // full: fills the frame and drifts in slowly
            return fade(fit(pic, into: box, cover: true, zoom: 1.04 + 0.08 * age / max(0.1, b.end - b.start)).cropped(to: box)).composited(over: frame)
        }
    }
}
