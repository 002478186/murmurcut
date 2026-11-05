import AVFoundation
import CoreImage
import UIKit

/// A caption look. Each one is data; `Captioner` draws them all.
struct Preset {
    enum Active { case color, box, none }
    enum Future { case show, dim, hide }
    var name: String
    var weight = UIFont.Weight.heavy
    var design = UIFontDescriptor.SystemDesign.default
    var caps = false
    var maxWords = 3
    var scale = 1.0
    var active = Active.color
    var future = Future.show
    var stroke = 0.0 // outline, as a share of the font size
    var pill = false
    var glow = false
    var gradient = false
    var pop = 1.0 // how much the spoken word grows
    var slam = false // the line lands from big to normal size
    var editorial = false // small serif words around one big italic keyword

    static let all = [
        Preset(name: "Karaoke", design: .rounded, maxWords: 4, future: .dim, pill: true),
        Preset(name: "Highlight", weight: .black, caps: true, active: .box),
        Preset(name: "Pop", weight: .black, caps: true, stroke: 0.12, pop: 1.22),
        Preset(name: "Slam", weight: .black, caps: true, maxWords: 1, scale: 1.7, stroke: 0.1, slam: true),
        Preset(name: "Neon", weight: .bold, design: .rounded, maxWords: 4, glow: true),
        Preset(name: "Gradient", weight: .black, design: .rounded, active: .none, stroke: 0.08, gradient: true, pop: 1.12),
        Preset(name: "Reveal", weight: .semibold, maxWords: 6, scale: 0.8, active: .none, future: .hide),
        Preset(name: "Editorial", weight: .regular, design: .serif, maxWords: 5, scale: 0.85, active: .none, editorial: true),
    ]

    static func named(_ name: String) -> Preset { all.first { $0.name == name } ?? all[0] }

    static let accents = [0xFFD60A, 0x32D74B, 0xFF3D8B, 0x3DE0FF, 0x9B7BFF, 0xFF8A3D].map {
        UIColor(red: CGFloat($0 >> 16) / 255, green: CGFloat($0 >> 8 & 255) / 255, blue: CGFloat($0 & 255) / 255, alpha: 1)
    }
}

/// Draws one caption line at time `t` into a top-left-origin context of `size`.
enum Captioner {
    static func draw(_ line: Line, at t: Double, preset p: Preset, project: Project, in ctx: CGContext, size: CGSize) {
        let accent = Preset.accents[project.accent % Preset.accents.count]
        let base = min(size.width, size.height * 0.5625) * 0.078 * project.size * p.scale
        let key = p.editorial && line.words.count > 1 ? line.words.indices.max { line.words[$0].text.count < line.words[$1].text.count } : nil

        // Lay the words out in centred rows that fit 86% of the width.
        struct Laid { var text: NSAttributedString; var font: UIFont; var width: CGFloat; var word: Word; var x = 0.0, row = 0 }
        var laid: [Laid] = line.words.enumerated().map { i, w in
            let font = i == key ? UIFont(descriptor: UIFont.systemFont(ofSize: base * 1.5).fontDescriptor.withDesign(.serif)!.withSymbolicTraits(.traitItalic)!, size: base * 1.5)
                : UIFont(descriptor: UIFont.systemFont(ofSize: base, weight: p.weight).fontDescriptor.withDesign(p.design)!, size: base)
            let text = NSAttributedString(string: p.caps ? w.text.uppercased() : w.text, attributes: [.font: font])
            return Laid(text: text, font: font, width: text.size().width, word: w)
        }
        let gap = base * 0.28, maxWidth = size.width * 0.86
        var rows: [[Int]] = [[]], rowWidth = 0.0
        for i in laid.indices {
            if !rows[rows.count - 1].isEmpty, rowWidth + gap + laid[i].width > maxWidth { rows.append([]); rowWidth = 0 }
            rowWidth += (rows[rows.count - 1].isEmpty ? 0 : gap) + laid[i].width
            rows[rows.count - 1].append(i)
        }
        let rowHeights = rows.map { $0.map { laid[$0].font.lineHeight }.max()! }
        let total = rowHeights.reduce(0, +)
        var y = size.height * project.position - total / 2
        var baselines: [CGFloat] = []
        for (r, row) in rows.enumerated() {
            let width = row.map { laid[$0].width }.reduce(0, +) + gap * Double(row.count - 1)
            var x = (size.width - width) / 2
            for i in row { laid[i].x = x; laid[i].row = r; x += laid[i].width + gap }
            baselines.append(y + rowHeights[r] * 0.8)
            y += rowHeights[r]
        }

        // The whole line fades and settles in.
        let enter = min(1, max(0, (t - line.start) / (p.slam ? 0.18 : 0.14)))
        let settle = p.slam ? 1.6 - 0.6 * easeOut(enter) : 0.92 + 0.08 * backOut(enter)
        ctx.saveGState()
        ctx.setAlpha(enter)
        let centre = CGPoint(x: size.width / 2, y: size.height * project.position)
        ctx.translateBy(x: centre.x, y: centre.y); ctx.scaleBy(x: settle, y: settle); ctx.translateBy(x: -centre.x, y: -centre.y)

        if p.pill {
            let w = rows.map { row in row.map { laid[$0].width }.reduce(0, +) + gap * Double(row.count - 1) }.max()!
            let box = CGRect(x: (size.width - w) / 2 - base * 0.45, y: centre.y - total / 2 - base * 0.25, width: w + base * 0.9, height: total + base * 0.5)
            ctx.addPath(UIBezierPath(roundedRect: box, cornerRadius: base * 0.45).cgPath)
            ctx.setFillColor(UIColor.black.withAlphaComponent(0.62).cgColor)
            ctx.fillPath()
        }

        for (i, l) in laid.enumerated() {
            let next = i + 1 < laid.count ? laid[i + 1].word.start : line.end
            let spoken = t >= l.word.start, active = spoken && t < next
            let grow = active ? 1 + (p.pop - 1) * backOut(min(1, (t - l.word.start) / 0.12)) : 1
            let colour: UIColor = i == key || (active && p.active == .color) ? accent
                : spoken || p.future == .show ? .white : .white.withAlphaComponent(p.future == .dim ? 0.5 : 0)
            let wordAlpha = !spoken && p.future == .hide ? 0 : 1.0
            let rect = CGRect(x: l.x, y: baselines[l.row] - l.font.ascender, width: l.width, height: l.font.ascender - l.font.descender)

            ctx.saveGState()
            ctx.setAlpha(enter * wordAlpha)
            ctx.translateBy(x: rect.midX, y: rect.midY); ctx.scaleBy(x: grow, y: grow); ctx.translateBy(x: -rect.midX, y: -rect.midY)
            if active && p.active == .box {
                ctx.addPath(UIBezierPath(roundedRect: rect.insetBy(dx: -base * 0.16, dy: -base * 0.02), cornerRadius: base * 0.2).cgPath)
                ctx.setFillColor(accent.cgColor)
                ctx.fillPath()
            }
            let fill = active && p.active == .box ? UIColor(white: 0.07, alpha: 1) : colour
            if p.stroke > 0 { text(l.text, colour: .black, stroke: p.stroke * 200, at: rect, in: ctx) }
            if p.glow {
                ctx.setShadow(offset: .zero, blur: base * (active ? 0.9 : 0.45), color: accent.cgColor)
            } else if p.stroke == 0 && !(active && p.active == .box) {
                ctx.setShadow(offset: CGSize(width: 0, height: base * 0.04), blur: base * 0.22, color: UIColor.black.withAlphaComponent(0.75).cgColor)
            }
            if p.gradient { // white text, then the gradient painted only where the text is
                ctx.beginTransparencyLayer(auxiliaryInfo: nil)
                text(l.text, colour: .white, at: rect, in: ctx)
                ctx.setBlendMode(.sourceIn)
                let colours = [UIColor.white.cgColor, accent.cgColor] as CFArray
                ctx.drawLinearGradient(CGGradient(colorsSpace: nil, colors: colours, locations: [0.2, 1])!, start: CGPoint(x: rect.midX, y: rect.minY), end: CGPoint(x: rect.midX, y: rect.maxY), options: [])
                ctx.endTransparencyLayer()
            } else {
                text(l.text, colour: fill, at: rect, in: ctx)
            }
            ctx.restoreGState()
        }
        ctx.restoreGState()
    }

    private static func text(_ s: NSAttributedString, colour: UIColor, stroke: Double = 0, at rect: CGRect, in ctx: CGContext) {
        let styled = NSMutableAttributedString(attributedString: s)
        styled.addAttributes(stroke > 0 ? [.strokeColor: colour, .strokeWidth: stroke] : [.foregroundColor: colour], range: NSRange(location: 0, length: s.length))
        ctx.setLineJoin(.round)
        UIGraphicsPushContext(ctx)
        styled.draw(at: rect.origin)
        UIGraphicsPopContext()
    }

    /// A text overlay: its words all on screen at once, in its own look and place.
    static func draw(_ o: Overlay, at t: Double, project: Project, in ctx: CGContext, size: CGSize) {
        let words = o.text.split(whereSeparator: \.isWhitespace).map { Word(text: String($0), start: o.start, end: o.end) }
        guard !words.isEmpty else { return }
        var p = Preset.named(o.preset)
        p.active = .none; p.future = .show; p.pop = 1
        var look = project
        look.position = o.y; look.size = o.size; look.accent = o.accent
        draw(Line(words: words), at: t, preset: p, project: look, in: ctx, size: size)
    }

    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
    static func backOut(_ x: Double) -> Double { let c = 1.70158; return 1 + (c + 1) * pow(x - 1, 3) + c * pow(x - 1, 2) }
}

// MARK: - Video

/// What the compositor needs to draw a frame: the project's look, its lines on the output timeline and how to place the video.
struct Frame {
    var project: Project
    var preset: Preset
    var lines: [Line]
    var orientation: CGImagePropertyOrientation
    var renderSize: CGSize

    func zoom(at t: Double) -> Double {
        guard project.punchIns else { return 1 }
        // Every third line punches in, with a quick ease at each end.
        for (i, l) in lines.enumerated() where i % 3 == 2 && t >= l.start && t < l.end + 0.1 {
            let ramp = min(1, (t - l.start) / 0.12, (l.end + 0.1 - t) / 0.12)
            return 1 + (project.zoom - 1) * Captioner.easeOut(max(0, ramp))
        }
        return 1
    }
}

final class Instruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let track: CMPersistentTrackID
    let scene: Frame

    init(_ range: CMTimeRange, track: CMPersistentTrackID, scene: Frame) {
        timeRange = range
        self.track = track
        self.scene = scene
        requiredSourceTrackIDs = [NSNumber(value: track)]
    }
}

/// Places the video in the chosen frame (fill, or fit over a blurred copy), punches in, then draws the caption.
final class Compositor: NSObject, AVVideoCompositing {
    static let context = CIContext(options: [.cacheIntermediates: false])
    let sourcePixelBufferAttributes: [String: any Sendable]? = [kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA]]
    let requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA]]

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        guard let ins = request.videoCompositionInstruction as? Instruction, let frame = request.sourceFrame(byTrackID: ins.track),
              let out = request.renderContext.newPixelBuffer() else {
            return request.finish(with: NSError(domain: "murmurcut", code: 1, userInfo: [NSLocalizedDescriptionKey: "No video frame"]))
        }
        let t = request.compositionTime.seconds, s = ins.scene, R = s.renderSize
        Self.context.render(Self.place(CIImage(cvPixelBuffer: frame), scene: s, zoom: s.zoom(at: t)), to: out, bounds: CGRect(origin: .zero, size: R), colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        let line = s.lines.last(where: { $0.start <= t + 0.05 && t < $0.end + 0.25 }), texts = s.project.texts.filter { t >= $0.start && t < $0.end }
        if line != nil || !texts.isEmpty {
            CVPixelBufferLockBaseAddress(out, [])
            if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(out), width: Int(R.width), height: Int(R.height), bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(out), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                ctx.translateBy(x: 0, y: R.height); ctx.scaleBy(x: 1, y: -1)
                if let line { Captioner.draw(line, at: t, preset: s.preset, project: s.project, in: ctx, size: R) }
                for o in texts { Captioner.draw(o, at: t, project: s.project, in: ctx, size: R) }
            }
            CVPixelBufferUnlockBaseAddress(out, [])
        }
        request.finish(withComposedVideoFrame: out)
    }

    static func place(_ source: CIImage, scene s: Frame, zoom: Double) -> CIImage {
        var img = source.oriented(s.orientation).oriented([.up, .right, .down, .left][s.project.turns % 4])
        if s.project.mirror { img = img.oriented(.upMirrored) }
        img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        let R = s.renderSize, w = img.extent.width, h = img.extent.height
        let frame = CGRect(origin: .zero, size: R)
        func fitted(_ scale: Double) -> CIImage {
            img.transformed(by: CGAffineTransform(scaleX: scale, y: scale).concatenating(CGAffineTransform(translationX: (R.width - w * scale) / 2, y: (R.height - h * scale) / 2)))
        }
        let fill = max(R.width / w, R.height / h)
        guard s.project.fit else { return Look.grade(fitted(fill * zoom).cropped(to: frame), s.project) }
        let back = fitted(fill).clampedToExtent().applyingGaussianBlur(sigma: 40).applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.6])
        return Look.grade(fitted(min(R.width / w, R.height / h) * zoom).composited(over: back).cropped(to: frame), s.project)
    }
}

/// A colour filter, like CapCut's: a named recipe of Core Image filters.
struct Look {
    let name: String
    let apply: (CIImage) -> CIImage

    static func controls(_ i: CIImage, sat: Double = 1, contrast: Double = 1, bright: Double = 0) -> CIImage {
        i.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: sat, kCIInputContrastKey: contrast, kCIInputBrightnessKey: bright])
    }
    /// Positive is warmer (more orange), negative cooler (more blue).
    static func warm(_ i: CIImage, _ amount: Double) -> CIImage {
        i.applyingFilter("CITemperatureAndTint", parameters: ["inputNeutral": CIVector(x: 6500, y: 0), "inputTargetNeutral": CIVector(x: 6500 - amount * 2500, y: 0)])
    }
    static func vignette(_ i: CIImage, _ amount: Double) -> CIImage {
        i.applyingFilter("CIVignette", parameters: [kCIInputIntensityKey: amount, kCIInputRadiusKey: max(i.extent.width, i.extent.height) * 0.9]).cropped(to: i.extent)
    }
    static func effect(_ name: String) -> (CIImage) -> CIImage { { $0.applyingFilter(name) } }

    static let all = [
        Look(name: "Original") { $0 },
        Look(name: "Vivid") { controls($0, sat: 1.4, contrast: 1.08) },
        Look(name: "Warm") { controls(warm($0, 0.6), sat: 1.1) },
        Look(name: "Cool") { warm($0, -0.6) },
        Look(name: "Cinematic") { vignette(warm(controls($0, sat: 0.85, contrast: 1.18, bright: -0.02), 0.25), 0.8) },
        Look(name: "Drama") { vignette(controls($0, sat: 0.7, contrast: 1.35), 1.2) },
        Look(name: "Film") { effect("CIPhotoEffectProcess")($0) },
        Look(name: "Vintage") { vignette(effect("CIPhotoEffectTransfer")($0), 0.6) },
        Look(name: "Instant") { effect("CIPhotoEffectInstant")($0) },
        Look(name: "Chrome") { effect("CIPhotoEffectChrome")($0) },
        Look(name: "Fade") { effect("CIPhotoEffectFade")($0) },
        Look(name: "Dreamy") { controls($0.applyingFilter("CIBloom", parameters: [kCIInputRadiusKey: 12, kCIInputIntensityKey: 0.7]).cropped(to: $0.extent), sat: 1.1, bright: 0.03) },
        Look(name: "B&W") { effect("CIPhotoEffectNoir")($0) },
        Look(name: "Mono") { effect("CIPhotoEffectMono")($0) },
    ]

    static func named(_ name: String) -> Look { all.first { $0.name == name } ?? all[0] }

    /// Every filter applied to one frame, for the filter picker.
    static func previews(_ frame: UIImage) -> [String: UIImage] {
        guard let cg = frame.cgImage else { return [:] }
        let image = CIImage(cgImage: cg)
        return Dictionary(uniqueKeysWithValues: all.compactMap { l in
            Compositor.context.createCGImage(l.apply(image).cropped(to: image.extent), from: image.extent).map { (l.name, UIImage(cgImage: $0)) }
        })
    }

    /// The project's filter at its strength, then the adjustments.
    static func grade(_ image: CIImage, _ p: Project) -> CIImage {
        var img = image
        if p.filter != "Original" && p.filterAmount > 0 {
            let graded = named(p.filter).apply(image)
            img = p.filterAmount >= 1 ? graded : image.applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: graded, kCIInputTimeKey: p.filterAmount])
        }
        if p.brightness != 0 || p.contrast != 1 || p.saturation != 1 { img = controls(img, sat: p.saturation, contrast: p.contrast, bright: p.brightness) }
        if p.warmth != 0 { img = warm(img, p.warmth) }
        if p.sharpen > 0 { img = img.applyingFilter("CISharpenLuminance", parameters: [kCIInputSharpnessKey: p.sharpen]) }
        if p.vignette > 0 { img = vignette(img, p.vignette * 2) }
        return img.cropped(to: image.extent)
    }
}

/// The cut video, ready for the player or the exporter.
struct Edit {
    let composition: AVMutableComposition
    let audioMix: AVMutableAudioMix
    let track: CMPersistentTrackID
    let natural: CGSize
    let orientation: CGImagePropertyOrientation
    let fps: Float

    init(_ project: Project) async throws {
        let asset = AVURLAsset(url: project.video)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw Captions.Failure(errorDescription: "This file has no video") }
        let clean = project.enhanceVoice && FileManager.default.fileExists(atPath: project.cleanVoice.path)
        let voice = clean ? AVURLAsset(url: project.cleanVoice) : asset // kept alive while its track is inserted
        let sound = try await voice.loadTracks(withMediaType: .audio).first
        let (size, transform, rate) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        composition = AVMutableComposition()
        let v = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        let a = sound == nil ? nil : composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        v.preferredTransform = transform
        let params = AVMutableAudioMixInputParameters(track: a)
        var at = CMTime.zero, joins: [CMTime] = []
        for (start, end) in project.kept {
            let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: end, preferredTimescale: 600))
            try v.insertTimeRange(range, of: video, at: at)
            if let a, let sound { try a.insertTimeRange(range, of: sound, at: at) }
            joins.append(at)
            at = at + range.duration
        }
        if project.speed != 1 { // stretches video and sound together; the player and exporter keep the pitch
            composition.scaleTimeRange(CMTimeRange(start: .zero, duration: at), toDuration: CMTimeMultiplyByFloat64(at, multiplier: 1 / project.speed))
        }
        // A tiny fade at each cut, so joins don't click.
        let fade = CMTime(value: 1, timescale: 60), volume = Float(project.volume)
        for (i, join) in joins.enumerated() {
            let start = CMTimeMultiplyByFloat64(join, multiplier: 1 / project.speed)
            let end = CMTimeMultiplyByFloat64(i + 1 < joins.count ? joins[i + 1] : at, multiplier: 1 / project.speed)
            params.setVolumeRamp(fromStartVolume: 0, toEndVolume: volume, timeRange: CMTimeRange(start: start, duration: fade))
            params.setVolumeRamp(fromStartVolume: volume, toEndVolume: 0, timeRange: CMTimeRange(start: end - fade, duration: fade))
        }
        audioMix = AVMutableAudioMix()
        audioMix.inputParameters = a == nil ? [] : [params]
        // Music loops under the whole video, dipping while someone talks.
        let music = project.musicFile.flatMap { FileManager.default.fileExists(atPath: $0.path) ? AVURLAsset(url: $0) : nil } // kept alive: a track can't be read once its asset is gone
        if let music, let song = try await music.loadTracks(withMediaType: .audio).first,
           let m = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            let range = try await song.load(.timeRange), total = composition.duration
            var t = CMTime.zero
            while range.duration.seconds > 0.1 && (total - t).seconds > 0.1 { // a sliver under a tenth of a second is left silent
                let piece = CMTimeMinimum(range.duration, total - t)
                try m.insertTimeRange(CMTimeRange(start: range.start, duration: piece), of: song, at: t)
                t = t + piece
            }
            let mp = AVMutableAudioMixInputParameters(track: m), loud = Float(project.musicVolume), low = loud * 0.3
            mp.setVolume(loud, at: .zero)
            if project.duck {
                for (from, to) in project.speech {
                    mp.setVolumeRamp(fromStartVolume: loud, toEndVolume: low, timeRange: CMTimeRange(start: CMTime(seconds: max(0, from - 0.3), preferredTimescale: 600), duration: CMTime(seconds: 0.3, preferredTimescale: 600)))
                    mp.setVolumeRamp(fromStartVolume: low, toEndVolume: loud, timeRange: CMTimeRange(start: CMTime(seconds: to, preferredTimescale: 600), duration: CMTime(seconds: 0.4, preferredTimescale: 600)))
                }
            }
            audioMix.inputParameters.append(mp)
        }
        track = v.trackID
        fps = rate > 0 ? min(60, rate) : 30
        // A video's rotation as an orientation: phones film sideways and store a 90° turn.
        let angle = atan2(transform.b, transform.a) * 180 / .pi
        orientation = abs(angle - 90) < 1 ? .right : abs(angle + 90) < 1 ? .left : abs(abs(angle) - 180) < 1 ? .down : .up
        natural = orientation == .right || orientation == .left ? CGSize(width: size.height, height: size.width) : size
    }

    /// The frame size in the chosen shape: the chosen quality on the short side (at most 1080 for the preview).
    func renderSize(_ project: Project, export: Bool = false) -> CGSize {
        let short = Double(export ? project.quality : min(project.quality, 1080))
        let r: Double = project.aspect.ratio ?? (project.turns % 2 == 1 ? natural.height / natural.width : natural.width / natural.height)
        let even = { (x: Double) in (x / 2).rounded() * 2 }
        return r < 1 ? CGSize(width: short, height: even(short / r)) : CGSize(width: even(short * r), height: short)
    }

    func videoComposition(_ project: Project, export: Bool = false) -> AVMutableVideoComposition {
        let preset = Preset.named(project.preset)
        let scene = Frame(project: project, preset: preset, lines: project.lines(maxWords: preset.maxWords), orientation: orientation, renderSize: renderSize(project, export: export))
        let vc = AVMutableVideoComposition()
        vc.customVideoCompositorClass = Compositor.self
        vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))
        vc.renderSize = scene.renderSize
        vc.instructions = [Instruction(CMTimeRange(start: .zero, duration: composition.duration), track: track, scene: scene)]
        return vc
    }
}
