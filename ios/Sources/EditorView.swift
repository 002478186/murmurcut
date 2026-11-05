import AVFoundation
import PhotosUI
import SwiftUI
import Translation

struct EditorView: View {
    enum Tool: String, CaseIterable {
        case captions = "Captions", style = "Style", text = "Text", audio = "Audio", edit = "Edit", filters = "Filters", format = "Format"
        var icon: String {
            ["Captions": "captions.bubble", "Style": "textformat", "Text": "character.textbox", "Audio": "waveform", "Edit": "scissors",
             "Filters": "camera.filters", "Format": "aspectratio"][rawValue]!
        }
    }
    struct WordRef: Identifiable { let id: Int }

    @State var project: Project
    @State private var history: [Project] = []
    @State private var lastChange: (key: AnyKeyPath, at: Date)?
    @State private var edit: Edit?
    @State private var player = AVPlayer()
    @State private var time = 0.0
    @State private var playing = false
    @State private var tool = Tool.captions
    @State private var transcribing = false
    @State private var failure: String?
    @State private var editing: WordRef?
    @State private var exporting = false
    @State private var thumbs: [UIImage] = []
    @State private var looks: [String: UIImage] = [:]
    @State private var overlay: UUID? // the text overlay being changed
    @State private var writing: Overlay? // the overlay whose words are being typed
    @State private var pickingMusic = false
    @State private var enhancing = false
    @State private var pickedClip: PhotosPickerItem?
    @State private var addingClip = false
    @State private var translating: TranslationSession.Configuration?
    @State private var translatingTo = ""

    static let targets = [("en", "English"), ("hi", "Hindi"), ("es", "Spanish"), ("fr", "French"), ("de", "German"), ("pt", "Portuguese"),
                          ("ar", "Arabic"), ("ja", "Japanese"), ("ko", "Korean"), ("zh", "Chinese")]

    private var preset: Preset { Preset.named(project.preset) }

    var body: some View {
        VStack(spacing: 0) {
            preview.frame(maxHeight: .infinity)
            transport
            Strip(thumbs: thumbs, lines: project.lines(maxWords: preset.maxWords), duration: max(0.1, project.outputDuration), time: time, seek: seek)
            panel.frame(height: 220).frame(maxWidth: .infinity, alignment: .top)
            toolbar
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Undo", systemImage: "arrow.uturn.backward", action: undo).disabled(history.isEmpty)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Export") { player.pause(); exporting = true }
                    .buttonStyle(BrandButton()).controlSize(.small)
                    .disabled(edit == nil)
            }
        }
        .task { await load() }
        .onDisappear { player.pause() }
        .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { _ in player.pause(); seek(0) }
        .sheet(isPresented: $exporting) { ExportView(project: project) }
        .sheet(item: $editing) { ref in
            if project.words.indices.contains(ref.id) {
                WordSheet(word: project.words[ref.id]) { text, cut in
                    change { if $0.words.indices.contains(ref.id) { $0.words[ref.id].text = text; $0.words[ref.id].cut = cut } }
                }
            }
        }
        .sheet(item: $writing) { o in
            TextSheet(text: o.text) { text in
                if let i = project.texts.firstIndex(where: { $0.id == o.id }) { change { $0.texts[i].text = text } } else { change { var n = o; n.text = text; $0.texts.append(n) } }
                overlay = o.id
            }
        }
        .translationTask(translating) { session in await translate(with: session) }
        .onChange(of: pickedClip) { _, item in
            guard let item else { return }
            Task {
                addingClip = true
                if let movie = try? await item.loadTransferable(type: Movie.self) { await addClip(movie.url) }
                addingClip = false
                pickedClip = nil
            }
        }
        .fileImporter(isPresented: $pickingMusic, allowedContentTypes: [.audio]) { result in
            if case .success(let url) = result { addMusic(url) } else if case .failure(let error) = result { failure = error.localizedDescription }
        }
        .alert("Something went wrong", isPresented: .constant(failure != nil)) { Button("OK") { failure = nil } } message: { Text(failure ?? "") }
    }

    // MARK: Preview and playback

    private var preview: some View {
        ZStack {
            if let edit {
                PlayerView(player: player)
                    .aspectRatio(edit.renderSize(project), contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
                    .onTapGesture(perform: togglePlay)
                    .accessibilityLabel(playing ? "Pause" : "Play")
            } else {
                ProgressView()
            }
            if !project.captioned { captionPrompt }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private var captionPrompt: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform").font(.largeTitle).foregroundStyle(Theme.brand).symbolEffect(.variableColor.iterative, isActive: transcribing)
            Text(transcribing ? "Listening to your video…" : "Make captions").font(.title3.bold())
            if !transcribing {
                languagePicker
                Button("Generate captions", systemImage: "sparkles") { Task { await transcribe() } }.buttonStyle(BrandButton())
            } else {
                Text("Runs on your phone. The first time, it downloads the language.").font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
        }
        .padding(24).frame(maxWidth: 300)
        .background(.ultraThinMaterial, in: .rect(cornerRadius: 24))
    }

    private var languagePicker: some View {
        Picker("Spoken language", selection: bind(\.language)) {
            ForEach(["auto"] + Captions.locales.keys.sorted { $0 == "english" || ($1 != "english" && $0 < $1) }, id: \.self) { Text(Self.languageName($0)) }
        }
        .pickerStyle(.menu)
    }

    private var transport: some View {
        HStack(spacing: 12) {
            Button(action: togglePlay) {
                Image(systemName: playing ? "pause.fill" : "play.fill").font(.title3).frame(width: 44, height: 44).background(Theme.raised, in: .circle)
            }
            .buttonStyle(.plain).accessibilityLabel(playing ? "Pause" : "Play")
            Text("\(stamp(time)) / \(stamp(project.outputDuration))").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.muted)
            Spacer()
            if project.outputDuration < project.duration - 0.05 {
                Label("\(String(format: "%.1f", project.duration - project.outputDuration)) s cut", systemImage: "scissors").font(.caption.bold()).foregroundStyle(Theme.pink)
            }
        }
        .padding(.horizontal, 16).padding(.bottom, 8)
    }

    static func languageName(_ l: String) -> String { l == "auto" ? "Detect automatically" : l == "hindi" ? "Hindi / Hinglish" : l.capitalized }

    private func stamp(_ t: Double) -> String { Duration.seconds(t).formatted(.time(pattern: .minuteSecond)) }

    private func togglePlay() {
        if player.rate > 0 { player.pause() } else { player.play() }
        playing = player.rate > 0
    }

    private func seek(_ t: Double) {
        time = t
        player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func load() async {
        do {
            let e = try await Edit(project)
            edit = e
            player.replaceCurrentItem(with: item(e))
            player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { t in
                time = t.seconds
                playing = player.rate > 0
            }
            DebugLog.add("editor: opened \(Int(project.duration))s video, \(project.words.count) words")
            thumbs = await Self.thumbnails(e)
            if let middle = thumbs.dropFirst(thumbs.count / 2).first { looks = await Task.detached { Look.previews(middle) }.value }
        } catch {
            DebugLog.add("editor: couldn't open: \(error)")
            failure = error.localizedDescription
        }
    }

    private func item(_ e: Edit) -> AVPlayerItem {
        let item = AVPlayerItem(asset: e.composition)
        item.videoComposition = e.videoComposition(project)
        item.audioMix = e.audioMix
        item.audioTimePitchAlgorithm = .spectral // keeps voices at their pitch when sped up or slowed down
        return item
    }

    static func thumbnails(_ e: Edit) async -> [UIImage] {
        let g = AVAssetImageGenerator(asset: e.composition)
        g.appliesPreferredTrackTransform = true
        g.maximumSize = CGSize(width: 160, height: 160)
        let length = e.composition.duration.seconds
        var out: [UIImage] = []
        for i in 0..<10 { if let cg = try? await g.image(at: CMTime(seconds: length * (Double(i) + 0.5) / 10, preferredTimescale: 600)).image { out.append(UIImage(cgImage: cg)) } }
        return out
    }

    private func transcribe() async {
        transcribing = true
        UIApplication.shared.isIdleTimerDisabled = true
        do {
            // Each clip is heard on its own; the language found in the first is used for the rest.
            var words: [Word] = [], heard = project.language
            for (clip, start) in zip(project.reel, project.clipStarts) {
                let (w, h) = try await Captions.transcribe(project.url(clip), language: heard)
                words += w.map { Word(text: $0.text, start: $0.start + start, end: $0.end + start) }
                heard = h
            }
            UserDefaults.standard.set(project.language, forKey: "spokenLanguage") // new videos start in the last language used
            DebugLog.add("captions: \(words.count) words in \(heard)")
            change { $0.words = words; $0.heard = heard; $0.captioned = true }
            if words.isEmpty { failure = "No speech was heard in this video." }
        } catch {
            failure = error.localizedDescription
        }
        UIApplication.shared.isIdleTimerDisabled = false
        transcribing = false
    }

    // MARK: Changes and undo

    /// Applies an edit, saves it and updates the preview. Quick repeats of one setting (a slider drag) undo as one step.
    private func change(_ key: AnyKeyPath? = nil, _ apply: (inout Project) -> Void) {
        let before = project
        apply(&project)
        guard project != before else { return }
        if key == nil || lastChange?.key != key || Date().timeIntervalSince(lastChange!.at) > 1 { history.append(before) }
        lastChange = key.map { ($0, Date()) }
        project.save()
        refresh(from: before)
    }

    private func undo() {
        guard let previous = history.popLast() else { return }
        let before = project
        project = previous
        project.save()
        refresh(from: before)
    }

    private func refresh(from before: Project) {
        guard let edit else { return }
        let sameSound = before.clips == project.clips && before.speed == project.speed && before.volume == project.volume && before.enhanceVoice == project.enhanceVoice
            && before.music == project.music && before.musicVolume == project.musicVolume && before.duck == project.duck
        if before.kept.map({ [$0.0, $0.1] }) == project.kept.map({ [$0.0, $0.1] }) && sameSound {
            player.currentItem?.videoComposition = edit.videoComposition(project)
            seek(time) // redraws the paused frame
        } else {
            Task { // the cuts or the sound changed, so the video itself is rebuilt
                guard let e = try? await Edit(project) else { return }
                self.edit = e
                player.replaceCurrentItem(with: item(e))
                seek(min(time, project.outputDuration))
                thumbs = await Self.thumbnails(e)
            }
        }
    }

    private func bind<T: Equatable>(_ key: WritableKeyPath<Project, T>) -> Binding<T> {
        Binding(get: { project[keyPath: key] }, set: { value in change(key) { $0[keyPath: key] = value } })
    }

    // MARK: Tools

    private var toolbar: some View {
        HStack {
            ForEach(Tool.allCases, id: \.self) { t in
                Button { tool = t } label: {
                    VStack(spacing: 4) {
                        Image(systemName: t.icon).font(.system(size: 20, weight: .semibold))
                        Text(t.rawValue).font(.caption2.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .foregroundStyle(tool == t ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.muted))
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.selection, trigger: tool)
            }
        }
        .padding(.horizontal, 8).padding(.top, 6)
        .background(Theme.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Theme.line.frame(height: 1) }
    }

    @ViewBuilder private var panel: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch tool {
            case .captions: captionsTool
            case .style: styleTool
            case .text: textTool
            case .audio: audioTool
            case .edit: ScrollView { VStack(alignment: .leading, spacing: 14) { editTool; cutsTool } }
            case .filters: filtersTool
            case .format: ScrollView { VStack(alignment: .leading, spacing: 14) { formatTool; zoomTool } }
            }
        }
        .padding(16)
        .tint(Theme.pink)
    }

    @ViewBuilder private var captionsTool: some View {
        HStack {
            Text(project.words.isEmpty ? "No captions yet" : translating != nil ? "Translating…"
                 : project.showTranslation && !project.translation.isEmpty ? "Showing the \(Self.targets.first { $0.0 == project.translatedTo }?.1 ?? "") translation"
                 : project.language == "auto" && project.heard != nil
                 ? "Heard \(Self.languageName(project.heard!)) · tap a word to fix it" : "Tap a word to fix or cut it")
                .font(.subheadline).foregroundStyle(Theme.muted)
            Spacer()
            if project.captioned {
                Menu {
                    Menu("Translate captions", systemImage: "globe") {
                        ForEach(Self.targets, id: \.0) { code, name in
                            Button(name) {
                                let from = Captions.codes.first { $0.value == (project.heard ?? project.language) }?.key
                                translatingTo = code
                                translating = TranslationSession.Configuration(source: from.map { Locale.Language(identifier: $0) }, target: Locale.Language(identifier: code))
                            }
                        }
                    }
                    if !project.translation.isEmpty {
                        Toggle("Show translation", systemImage: "character.bubble", isOn: bind(\.showTranslation))
                    }
                    Divider()
                    languagePicker
                    Button("Redo captions", systemImage: "arrow.clockwise") { Task { await transcribe() } }
                } label: { Label("More", systemImage: "ellipsis.circle").font(.subheadline.bold()) }
                .disabled(transcribing || translating != nil)
            }
        }
        let keep = project.kept
        ScrollView {
            Flow(spacing: 6) {
                ForEach(project.words.indices, id: \.self) { i in
                    let w = project.words[i], cut = project.isCut(w)
                    let at = Project.outputTime(w.start, kept: keep).map { $0 / project.speed }
                    let active = at.map { time >= $0 && time < $0 + (w.end - w.start) / project.speed } ?? false
                    Text(w.text)
                        .font(.callout.weight(active ? .bold : .regular))
                        .strikethrough(cut, color: .red)
                        .foregroundStyle(cut ? .red.opacity(0.8) : .white)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(active ? Theme.pink.opacity(0.35) : Theme.surface, in: .rect(cornerRadius: 8))
                        .onTapGesture {
                            if let at { seek(at) }
                            editing = WordRef(id: i)
                        }
                }
            }
        }
    }

    @ViewBuilder private var styleTool: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Preset.all, id: \.name) { p in
                    PresetCard(preset: p, accent: project.accent, selected: p.name == project.preset)
                        .onTapGesture { change { $0.preset = p.name } }
                }
            }
        }
        .scrollClipDisabled()
        HStack(spacing: 10) {
            ForEach(Preset.accents.indices, id: \.self) { i in
                Circle().fill(Color(Preset.accents[i])).frame(width: 28, height: 28)
                    .overlay(Circle().strokeBorder(.white, lineWidth: project.accent == i ? 3 : 0))
                    .frame(width: 44, height: 44).contentShape(.circle)
                    .onTapGesture { change { $0.accent = i } }
                    .accessibilityLabel("Colour \(i + 1)").accessibilityAddTraits(project.accent == i ? .isSelected : [])
            }
        }
        slider("Size", bind(\.size), 0.6...1.6)
        slider("Height", bind(\.position), 0.15...0.88)
    }

    @ViewBuilder private var editTool: some View {
                Text("Clips").font(.subheadline).foregroundStyle(Theme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(project.reel.indices, id: \.self) { i in
                            let n = project.reel.count
                            Menu {
                                Button("Move left", systemImage: "arrow.left") { move(i, by: -1) }.disabled(i == 0)
                                Button("Move right", systemImage: "arrow.right") { move(i, by: 1) }.disabled(i == n - 1)
                                Button("Delete clip", systemImage: "trash", role: .destructive) { change { $0 = $0.rearranged(Array(0..<n).filter { $0 != i }) } }.disabled(n == 1)
                            } label: {
                                Label("\(i + 1) · \(stamp(project.reel[i].duration))", systemImage: "film")
                                    .font(.subheadline.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 40)
                                    .background(Theme.surface, in: .capsule).overlay(Capsule().strokeBorder(Theme.line))
                            }
                        }
                        PhotosPicker(selection: $pickedClip, matching: .videos) {
                            Label(addingClip ? "Adding…" : "Add clip", systemImage: "plus").font(.subheadline.bold()).padding(.horizontal, 14).frame(minHeight: 40)
                                .background(Theme.raised, in: .capsule)
                        }
                        .disabled(addingClip)
                    }
                }
                HStack {
                    Chip(title: "Split", icon: "scissors") { let t = project.sourceTime(time); change { $0.splits.append(t) } }
                    Chip(title: "Delete part", icon: "trash") { deletePart() }
                    if !project.removed.isEmpty { Chip(title: "Restore", icon: "arrow.uturn.backward") { change { $0.removed = [] } } }
                }
                Text("Split at the playhead, then delete the part it's in.").font(.footnote).foregroundStyle(Theme.muted)
                Text("Transition").font(.subheadline).foregroundStyle(Theme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack { ForEach(["None", "Fade", "Flash", "Zoom", "Blur"], id: \.self) { k in Chip(title: k, selected: project.transition == k) { change { $0.transition = k } } } }
                }
                if project.transition != "None" {
                    Toggle(isOn: bind(\.transitionOnCuts)) {
                        Text("On every jump cut too")
                        Text(project.reel.count > 1 ? "Not just between clips" : "With one clip, transitions play at cuts")
                    }
                }
                slider("Start \(stamp(project.trimIn * project.duration))", Binding(get: { project.trimIn }, set: { v in change(\Project.trimIn) { $0.trimIn = min(v, $0.trimOut - 0.02) } }), 0...0.98)
                slider("End \(stamp(project.trimOut * project.duration))", Binding(get: { project.trimOut }, set: { v in change(\Project.trimOut) { $0.trimOut = max(v, $0.trimIn + 0.02) } }), 0.02...1)
                Text("Speed").font(.subheadline).foregroundStyle(Theme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach([0.5, 0.75, 1, 1.25, 1.5, 2], id: \.self) { x in
                            Chip(title: "\(x.formatted())×", selected: project.speed == x) { change { $0.speed = x } }
                        }
                    }
                }
                HStack {
                    Chip(title: "Rotate", icon: "rotate.right") { change { $0.turns = ($0.turns + 1) % 4 } }
                    Chip(title: "Mirror", icon: "arrow.left.and.right", selected: project.mirror) { change { $0.mirror.toggle() } }
                }
    }

    @ViewBuilder private var audioTool: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Toggle(isOn: Binding(get: { project.enhanceVoice }, set: { on in Task { await enhance(on) } })) {
                    Text("Enhance voice")
                    Text(enhancing ? "Cleaning up the sound…" : "Takes out background noise, on your phone")
                }
                .disabled(enhancing)
                HStack {
                    slider("Voice \(Int(project.volume * 100))%", bind(\.volume), 0...1)
                    Button { change { $0.volume = $0.volume == 0 ? 1 : 0 } } label: { Image(systemName: project.volume == 0 ? "speaker.slash.fill" : "speaker.wave.2.fill").frame(width: 44, height: 44) }
                        .accessibilityLabel(project.volume == 0 ? "Unmute" : "Mute")
                }
                HStack {
                    Text("Music").font(.subheadline.bold())
                    Spacer()
                    if project.music != nil {
                        Button("Remove", role: .destructive) { removeMusic() }.font(.subheadline.bold())
                    }
                    Button(project.music == nil ? "Add music" : "Change", systemImage: "music.note") { pickingMusic = true }.font(.subheadline.bold())
                }
                if project.music != nil {
                    slider("Music \(Int(project.musicVolume * 100))%", bind(\.musicVolume), 0...1)
                    Toggle(isOn: bind(\.duck)) {
                        Text("Lower music when talking")
                        Text("Your voice stays clear over the song")
                    }
                } else {
                    Text("Pick a song or sound from Files. It loops under the whole video.").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
        }
    }

    @ViewBuilder private var textTool: some View {
        HStack {
            Button("Add text", systemImage: "plus") {
                player.pause()
                writing = Overlay(text: "", start: time, end: min(project.outputDuration, time + 3))
            }
            .buttonStyle(BrandButton()).controlSize(.small)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack { ForEach(project.texts) { o in Chip(title: o.text, selected: o.id == overlay) { overlay = o.id; seek(o.start) } } }
            }
        }
        if let i = project.texts.firstIndex(where: { $0.id == overlay }) {
            let o = project.texts[i]
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            Chip(title: "Edit words", icon: "pencil") { writing = o }
                            ForEach(Preset.all, id: \.name) { p in Chip(title: p.name, selected: o.preset == p.name) { change { $0.texts[i].preset = p.name } } }
                        }
                    }
                    HStack(spacing: 10) {
                        ForEach(Preset.accents.indices, id: \.self) { c in
                            Circle().fill(Color(Preset.accents[c])).frame(width: 26, height: 26)
                                .overlay(Circle().strokeBorder(.white, lineWidth: o.accent == c ? 3 : 0))
                                .frame(width: 40, height: 40).contentShape(.circle)
                                .onTapGesture { change { $0.texts[i].accent = c } }
                                .accessibilityLabel("Colour \(c + 1)")
                        }
                    }
                    slider("Size", Binding(get: { o.size }, set: { v in change(\Project.texts) { $0.texts[i].size = v } }), 0.5...2.5)
                    slider("Height", Binding(get: { o.y }, set: { v in change(\Project.texts) { $0.texts[i].y = v } }), 0.08...0.92)
                    Text("Shows \(stamp(o.start)) to \(stamp(o.end))").font(.subheadline).foregroundStyle(Theme.muted)
                    HStack {
                        Chip(title: "Start here", icon: "arrow.right.to.line") { change { $0.texts[i].start = min(time, $0.texts[i].end - 0.2) } }
                        Chip(title: "End here", icon: "arrow.left.to.line") { change { $0.texts[i].end = max(time, $0.texts[i].start + 0.2) } }
                        Chip(title: "Delete", icon: "trash") { overlay = nil; change { $0.texts.remove(at: i) } }
                    }
                }
            }
        } else {
            Text(project.texts.isEmpty ? "Put a title or a label on the video. It starts where the playhead is." : "Tap a text to change it.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func enhance(_ on: Bool) async {
        if on {
            enhancing = true
            defer { enhancing = false }
            for clip in project.reel where !FileManager.default.fileExists(atPath: project.cleanVoice(clip).path) {
                do { try await Voice.enhance(project.url(clip), to: project.cleanVoice(clip)) } catch {
                    DebugLog.add("voice: failed: \(error)")
                    failure = error.localizedDescription
                    return
                }
            }
        }
        change { $0.enhanceVoice = on }
    }

    /// Every sentence translated on the phone, each timed like the sentence it came from.
    private func translate(with session: TranslationSession) async {
        defer { translating = nil }
        let sentences = project.sentences
        let asks = sentences.indices.map { TranslationSession.Request(sourceText: sentences[$0].map(\.text).joined(separator: " "), clientIdentifier: String($0)) }
        do {
            var out: [Word] = []
            for reply in try await session.translations(from: asks) {
                guard let i = reply.clientIdentifier.flatMap(Int.init), let s = sentences[safe: i], let first = s.first, let last = s.last else { continue }
                out += Project.spread(reply.targetText, from: first.start, to: last.end)
            }
            let code = translatingTo
            change { $0.translation = out.sorted { $0.start < $1.start }; $0.translatedTo = code; $0.showTranslation = true }
            DebugLog.add("captions: translated \(sentences.count) sentences to \(code)")
        } catch {
            DebugLog.add("captions: translation failed: \(error)")
            failure = "Couldn't translate: \(error.localizedDescription)"
        }
    }

    private func move(_ i: Int, by step: Int) {
        var order = Array(project.reel.indices)
        order.swapAt(i, i + step)
        change { $0 = $0.rearranged(order) }
    }

    private func deletePart() {
        let (a, b) = project.part(at: project.sourceTime(time))
        guard project.outputDuration - (b - a) / project.speed > 0.5 else { failure = "That would delete the whole video."; return }
        change { $0.removed.append([a, b]) }
        DebugLog.add("edit: deleted \(String(format: "%.1f-%.1f", a, b))")
    }

    /// Puts another video at the end, captioned like the rest.
    private func addClip(_ url: URL) async {
        let name = "clip-\(UUID().uuidString.prefix(8)).mov"
        do {
            try FileManager.default.moveItem(at: url, to: project.folder.appendingPathComponent(name))
            let length = try await AVURLAsset(url: project.folder.appendingPathComponent(name)).load(.duration).seconds
            let start = project.duration
            change { p in
                let old = p.duration
                p.clips = p.reel + [Clip(file: name, duration: length)]
                p.duration = old + length
                p.trimIn *= old / p.duration // trims stay where they were in the first clips
                if p.trimOut < 1 { p.trimOut *= old / p.duration }
            }
            DebugLog.add("edit: added a \(Int(length)) s clip")
            guard let clip = project.clips.last else { return }
            if project.enhanceVoice { try? await Voice.enhance(project.url(clip), to: project.cleanVoice(clip)); refresh(from: Project()) }
            if project.captioned {
                transcribing = true
                defer { transcribing = false }
                let (w, _) = try await Captions.transcribe(project.url(clip), language: project.heard ?? project.language)
                change { $0.words += w.map { Word(text: $0.text, start: $0.start + start, end: $0.end + start) } }
            }
        } catch {
            DebugLog.add("edit: couldn't add a clip: \(error)")
            failure = error.localizedDescription
        }
    }

    private func addMusic(_ url: URL) {
        let open = url.startAccessingSecurityScopedResource()
        defer { if open { url.stopAccessingSecurityScopedResource() } }
        let name = "music-\(UUID().uuidString.prefix(8)).\(url.pathExtension.isEmpty ? "m4a" : url.pathExtension)"
        do {
            try FileManager.default.copyItem(at: url, to: project.folder.appendingPathComponent(name))
            let old = project.musicFile
            change { $0.music = name }
            if let old { try? FileManager.default.removeItem(at: old) }
            DebugLog.add("music: added \(url.lastPathComponent)")
        } catch { failure = "Couldn't add that song: \(error.localizedDescription)" }
    }

    private func removeMusic() {
        let old = project.musicFile
        change { $0.music = nil }
        if let old { try? FileManager.default.removeItem(at: old) }
    }

    @ViewBuilder private var filtersTool: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(Look.all, id: \.name) { l in
                            FilterCard(name: l.name, image: looks[l.name] ?? thumbs.first, selected: project.filter == l.name)
                                .onTapGesture { change { $0.filter = l.name; $0.filterAmount = 1 } }
                        }
                    }
                }
                .scrollClipDisabled()
                if project.filter != "Original" { slider("Strength", bind(\.filterAmount), 0...1) }
                HStack {
                    Text("Adjust").font(.subheadline.bold())
                    Spacer()
                    Button("Reset") { change { $0.brightness = 0; $0.contrast = 1; $0.saturation = 1; $0.warmth = 0; $0.vignette = 0; $0.sharpen = 0 } }
                        .font(.subheadline.bold())
                }
                slider("Brightness", bind(\.brightness), -0.3...0.3)
                slider("Contrast", bind(\.contrast), 0.6...1.5)
                slider("Saturation", bind(\.saturation), 0...2)
                slider("Warmth", bind(\.warmth), -1...1)
                slider("Vignette", bind(\.vignette), 0...1)
                slider("Sharpen", bind(\.sharpen), 0...1)
            }
        }
    }

    @ViewBuilder private var cutsTool: some View {
        let fillers = project.words.filter(Project.isFiller).count
        Toggle(isOn: bind(\.cutFillers)) {
            Text("Remove ums and uhs")
            Text(fillers == 1 ? "1 found" : "\(fillers) found")
        }
        Toggle(isOn: bind(\.cutPauses)) {
            Text("Remove pauses")
            Text("Jump-cut the silences between sentences")
        }
        if project.cutPauses { slider("Longer than \(String(format: "%.1f", project.maxPause)) s", bind(\.maxPause), 0.3...1.5) }
        Text("Cut single words by tapping them under Captions.").font(.footnote).foregroundStyle(Theme.muted)
    }

    @ViewBuilder private var formatTool: some View {
        Text("Background").font(.subheadline).foregroundStyle(Theme.muted)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack { ForEach(Compositor.backgrounds, id: \.self) { b in Chip(title: b == "Keep" ? "Original" : b, selected: project.background == b) { change { $0.background = b } } } }
        }
        Text("Export quality").font(.subheadline).foregroundStyle(Theme.muted)
        HStack { ForEach([720, 1080, 2160], id: \.self) { q in Chip(title: q == 2160 ? "4K" : "\(q)p", selected: project.quality == q) { change { $0.quality = q } } } }
        Text("Shape").font(.subheadline).foregroundStyle(Theme.muted)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack { ForEach(Aspect.allCases, id: \.self) { a in Chip(title: a.rawValue, selected: project.aspect == a) { change { $0.aspect = a } } } }
        }
        Text("Fit").font(.subheadline).foregroundStyle(Theme.muted)
        HStack {
            Chip(title: "Fill and crop", icon: "crop", selected: !project.fit) { change { $0.fit = false } }
            Chip(title: "Fit over blur", icon: "rectangle.center.inset.filled", selected: project.fit) { change { $0.fit = true } }
        }
    }

    @ViewBuilder private var zoomTool: some View {
        Toggle(isOn: bind(\.punchIns)) {
            Text("Punch-in zooms")
            Text("Zoom in on every third caption, like a jump cut")
        }
        if project.punchIns { slider("Strength", bind(\.zoom), 1.05...1.4) }
    }

    private func slider(_ title: String, _ value: Binding<Double>, _ range: ClosedRange<Double>) -> some View {
        HStack {
            Text(title).font(.subheadline).foregroundStyle(Theme.muted).frame(width: 130, alignment: .leading)
            Slider(value: value, in: range)
        }
    }
}

/// The edit's frames with a mark for each caption line and the playhead. Drag to scrub.
struct Strip: View {
    let thumbs: [UIImage]
    let lines: [Line]
    let duration: Double
    let time: Double
    let seek: (Double) -> Void

    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            ZStack(alignment: .topLeading) {
                HStack(spacing: 0) {
                    ForEach(thumbs.indices, id: \.self) { Image(uiImage: thumbs[$0]).resizable().scaledToFill().frame(width: w / Double(thumbs.count), height: 40).clipped() }
                }
                .frame(width: w, height: 40, alignment: .leading)
                .background(Theme.surface)
                .clipShape(.rect(cornerRadius: 8))
                .offset(y: 14)
                ForEach(lines.indices, id: \.self) { i in
                    Capsule().fill(Theme.brand)
                        .frame(width: max(3, (lines[i].end - lines[i].start) / duration * w - 2), height: 6)
                        .offset(x: lines[i].start / duration * w, y: 2)
                }
                Capsule().fill(.white).frame(width: 3, height: 62).shadow(radius: 3).offset(x: min(1, time / duration) * w - 1.5)
            }
            .contentShape(.rect)
            .gesture(DragGesture(minimumDistance: 0).onChanged { seek(min(1, max(0, $0.location.x / w)) * duration) })
        }
        .frame(height: 62)
        .padding(.horizontal, 16).padding(.bottom, 4)
        .accessibilityElement().accessibilityLabel("Timeline").accessibilityValue("\(Int(time)) of \(Int(duration)) seconds")
    }
}

/// A preset playing a sample line, so each style shows itself.
struct PresetCard: View {
    let preset: Preset
    let accent: Int
    let selected: Bool

    static let sample = Project(duration: 2.6, words: [
        Word(text: "Make", start: 0.15, end: 0.5), Word(text: "every", start: 0.5, end: 0.85),
        Word(text: "word", start: 0.85, end: 1.3), Word(text: "count", start: 1.35, end: 2.2),
    ], size: 2.6, position: 0.5)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { tick in
            Canvas { g, size in
                var sample = Self.sample
                sample.accent = accent
                let t = tick.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: sample.duration)
                guard let line = sample.lines(maxWords: preset.maxWords).last(where: { $0.start <= t + 0.05 }) else { return }
                g.withCGContext { Captioner.draw(line, at: t, preset: preset, project: sample, in: $0, size: size) }
            }
        }
        .frame(width: 104, height: 118)
        .background(LinearGradient(colors: [Color(white: 0.22), Color(white: 0.1)], startPoint: .top, endPoint: .bottom))
        .overlay(alignment: .bottom) { Text(preset.name).font(.caption.bold()).padding(.bottom, 6) }
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(selected ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.line), lineWidth: selected ? 2.5 : 1))
        .accessibilityElement().accessibilityLabel("\(preset.name) style").accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// One filter, shown on a frame of the video.
struct FilterCard: View {
    let name: String
    let image: UIImage?
    let selected: Bool

    var body: some View {
        VStack(spacing: 6) {
            Color.clear.frame(width: 66, height: 88)
                .overlay { if let image { Image(uiImage: image).resizable().scaledToFill() } else { Theme.surface } }
                .clipShape(.rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? AnyShapeStyle(Theme.brand) : AnyShapeStyle(Theme.line), lineWidth: selected ? 2.5 : 1))
            Text(name).font(.caption2.weight(.semibold)).foregroundStyle(selected ? .white : Theme.muted)
        }
        .contentShape(.rect)
        .accessibilityElement().accessibilityLabel("\(name) filter").accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Type the words of a text overlay.
struct TextSheet: View {
    @State var text: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            TextField("Your text", text: $text, axis: .vertical)
                .font(.title2.bold()).multilineTextAlignment(.center).lineLimit(1...4)
                .padding(14).background(Theme.surface, in: .rect(cornerRadius: 14))
            Button("Done") { if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { save(text) }; dismiss() }
                .buttonStyle(BrandButton()).frame(maxWidth: .infinity)
        }
        .padding(20)
        .presentationDetents([.height(230)])
        .presentationBackground(Theme.bg)
    }
}

/// Fix the spelling of one word, or cut it.
struct WordSheet: View {
    let word: Word
    let save: (String, Bool) -> Void
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            TextField("Word", text: $text)
                .font(.title2.bold()).multilineTextAlignment(.center)
                .padding(14).background(Theme.surface, in: .rect(cornerRadius: 14))
                .submitLabel(.done).onSubmit { save(text, word.cut); dismiss() }
            HStack(spacing: 12) {
                Button(word.cut ? "Keep word" : "Cut word", systemImage: word.cut ? "arrow.uturn.backward" : "scissors") { save(text, !word.cut); dismiss() }
                    .font(.headline).frame(maxWidth: .infinity, minHeight: 50).background(Theme.raised, in: .capsule).buttonStyle(.plain)
                Button("Save") { save(text, word.cut); dismiss() }.buttonStyle(BrandButton()).frame(maxWidth: .infinity)
            }
        }
        .padding(20)
        .onAppear { text = word.text }
        .presentationDetents([.height(190)])
        .presentationBackground(Theme.bg)
    }
}

/// Lays out its children left to right, wrapping like text.
struct Flow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = place(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: proposal.width ?? rows.map(\.maxX).max() ?? 0, height: rows.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (frame, view) in zip(place(subviews, width: bounds.width), subviews) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var frames: [CGRect] = [], x = 0.0, y = 0.0, rowHeight = 0.0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return frames
    }
}

struct PlayerView: UIViewRepresentable {
    let player: AVPlayer
    final class Layer: UIView { override static var layerClass: AnyClass { AVPlayerLayer.self } }

    func makeUIView(context: Context) -> Layer {
        let v = Layer()
        (v.layer as! AVPlayerLayer).player = player
        return v
    }

    func updateUIView(_ v: Layer, context: Context) {}
}
