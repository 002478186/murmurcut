# murmurcut for iPhone

A native SwiftUI app: import or film a talking clip, and murmurcut captions it on the phone with Apple's speech
recognition, animates the captions word by word, cuts the ums and pauses, and exports a 1080p MP4 to Photos.

- **Captions**: on-device `SpeechAnalyzer` (iOS 26), 14 languages; Hindi comes out in Hinglish spelling. "Detect automatically" hears the
  first minute in English, Hindi and the phone's languages and keeps the surest (Hindi words count for Hindi, so Hinglish lands there). Tap any word to fix or cut it.
- **Edit**: several clips one after another (add, reorder, delete), split at the playhead and delete a part, transitions
  between clips or at every jump cut (Fade, Flash, Zoom, Blur), trim, speed 0.5×–2× (voices keep their pitch), rotate and mirror.
- **Translate**: captions translated on the phone (Apple's Translation), sentence by sentence, keeping each sentence's timing.
- **Background**: swap what's behind the person for blur or a colour (Vision person segmentation; not on the simulator).
- **Teleprompter**: an optional script scrolls over the top of the camera while filming.
- **Text**: titles and labels placed on the video for a chosen stretch, in any caption style and colour, sized and positioned freely.
- **Audio**: Enhance voice (Apple's on-device voice isolation, `Audio.swift`), voice volume and mute, and background music from Files
  that loops under the video and dips while someone talks.
- **Filters**: 13 looks (Vivid, Warm, Cool, Cinematic, Drama, Film, Vintage, Instant, Chrome, Fade, Dreamy, B&W, Mono) with a strength
  slider, plus brightness, contrast, saturation, warmth, vignette and sharpen.
- **Style**: 8 animated presets (Karaoke, Highlight, Pop, Slam, Neon, Gradient, Reveal, Editorial), 6 colours, size and height.
- **Cuts**: remove filler words and pauses longer than a length you choose, with a short fade at each join.
- **Format**: 9:16, 4:5, 1:1, 16:9 or the original shape, filled and cropped or fitted over a blurred copy; export at 720p, 1080p or 4K.
- **Zoom**: punch-in zooms on every third caption.
- **Export**: the preview and the export share one renderer (`Render.swift`), so the file matches what you saw. Also exports an `.srt`.

## Build and install

```bash
cd ios
xcodegen generate
xcodebuild -project Murmurcut.xcodeproj -scheme Murmurcut -configuration Release \
  -destination id=<iPhone UDID> -derivedDataPath build -allowProvisioningUpdates DEVELOPMENT_TEAM=<your team ID> build
xcrun devicectl device install app --device <iPhone UDID> build/Build/Products/Release-iphoneos/Murmurcut.app
```

A free Apple ID signs it for 7 days and allows 3 sideloaded apps per phone. GitHub Actions also builds an unsigned
IPA on every push to `ios/` (`.github/workflows/ios.yml`).

## Code

| File | What it does |
| --- | --- |
| `Project.swift` | The saved project, and the pure edit logic: cut ranges, cut-aware timing, caption lines, SRT |
| `Captions.swift` | On-device transcription with word timings |
| `Render.swift` | Caption presets, filters (`Look`), the video compositor and the cut composition |
| `HomeView.swift`, `EditorView.swift`, `ExportView.swift` | The screens |
