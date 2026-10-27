# murmurcut

**Free, private AI captions, b-roll and jump cuts for talking-head videos. Everything runs in your browser.**

**▶ Try it: https://002478186.github.io/murmurcut/**

**On iPhone:** open that link in Safari, tap Share, then Add to Home Screen. It opens full screen like an app. Safari gives a page far less memory on iPhone, so there it uses the smallest caption model (whisper-tiny) 30 seconds at a time. Captions come out rougher than on a computer, Hindi especially; fix them under Fix the words.

Drop in a talking clip and murmurcut does seven things:

1. **Captions.** It transcribes the clip with word-level timestamps, using OpenAI's Whisper running locally through [transformers.js](https://github.com/huggingface/transformers.js). It can also translate the speech to English: talk in Hindi, Hinglish or 13 other languages and get English captions.
2. **Styles.** It animates the captions word by word in one of 10 styles: Spotlight, Pop, Beast, Bounce, Karaoke, Sunset, Neon, Outline, Typewriter or Minimal. Spotlight is the talking-head look of small lead-in words over one big italic keyword, placed off-centre and blurred in.
3. **B-roll.** It works out what you are talking about (names, products, places, numbers) and places a photo on each main point. A photo can fill the screen, sit on a card over you, or float with you blurred behind it. Photos come from Wikipedia and Openverse, plus Pexels and Unsplash if you add free keys, and every one is credited. A small on-device model ranks them by meaning. Optionally, an AI language model running in the tab reads each sentence and writes the search ("skyline mumbai" instead of just "Mumbai"). When nothing fits, you get a styled text card instead of a wrong photo.
4. **Your words.** Whisper mishears names and slang. Replace a word everywhere, or paste the script you actually read: murmurcut keeps the timing of your voice and uses your exact words, so Hinglish captions come out as you said them.
5. **Second videos.** Add a screen recording, gameplay or any other clip. It plays on a split screen (the clip on top, you below), and you split it at the playhead so each part lines up with what you are saying.
6. **Smart cuts and clean sound.** It removes filler words and pauses, or any word you click, and adds a punch-in zoom every few lines. On export it reduces background noise (fans, traffic, hum) with RNNoise and evens out the loudness.
7. **Export.** It renders an MP4 frame by frame, at least 1080 pixels wide, with the cuts applied to picture and sound alike, plus an `.srt` file that matches the cut video. It can also export the captions alone on a green screen, to layer over another edit.

There is no account, no watermark, no credits and no upload: your video never leaves your machine. The only data sent anywhere is the photo search words, which go to Wikipedia, Openverse and, if you add keys, Pexels and Unsplash.

## Run it

It is a static site with no build step. Serve the folder over HTTP, because module workers do not load from `file://`:

```bash
npm start            # or: python -m http.server 8000
```

Open the printed URL in Chrome or Edge, which export with WebCodecs. Other browsers fall back to recording the preview in real time, which needs the tab visible and can drop frames on a slow machine.

The first transcription downloads the Whisper model; Accurate is the bigger download. The browser caches it after that. murmurcut runs Whisper on your GPU through WebGPU when the browser supports it, and falls back to the much slower CPU otherwise.

## How to use it

| Step | What happens |
| --- | --- |
| **Import** | Drop in a video or click to choose one. MP4 (H.264) or WebM work best. |
| **Captions** | Pick the spoken language, and whether the captions should stay in it or be translated to English. Hindi gives the best results with English captions, because Whisper's Hindi transcription is unreliable. |
| **Fix the words** | Under Captions, replace a misheard word everywhere ("Capsule" with "Kapso"). Or paste the script you read and press *Use my script*: each script line becomes a caption line, timed to your voice, with pauses kept so they can still be cut. This is the way to get Hinglish captions in your own spelling. |
| **Chat to edit** | Type what you want under the preview, for example "remove the ums, zoom in at 0:12 and make it square", "style beast", "add a photo of mumbai here" or "replace capsule with Kapso". Several instructions can go in one line. It runs instantly and offline. If it doesn't understand something, it says so and suggests what to try. |
| **Style** | Every caption preset previews itself live. Then set the size, the position and the capitalisation. |
| **Scale** | Export as 9:16 (Reels, Shorts), 4:5, 1:1, 16:9 (YouTube) or the original shape. Either fill and crop (and choose which part of the frame to keep), or fit the whole frame over blurred edges. Choose the layout too: full screen, or split screen with the b-roll on top and you below. |
| **Zoom** | Automatic punch-ins on every third line, plus smooth zooms you add at the playhead, each with its own strength and length. |
| **B-roll** | Turn on *Let AI write the photo searches* for searches that understand each sentence (a one-time model download of about 500–800 MB). Under *More photo sources*, paste free [Pexels](https://www.pexels.com/api/) and [Unsplash](https://unsplash.com/oauth/applications) keys. They are stored only in your browser. Each moment shows its photo, time and search word. Change the search, swap to the next photo, upload your own, choose how it appears, or add a new moment at the playhead. Copy the photo credits into your video description. *Add a video clip* lays a screen recording or any other video over the timeline from the playhead, on a split screen. Move the playhead and press *Split at playhead*, then set which part of the clip each piece plays (*Clip from* and *to*); a piece stretches or squeezes its part to fit. |
| **Cuts & sound** | Remove `um`/`uh` fillers and pauses longer than a length you choose. Click any word in Captions to cut it. Cut parts show in red on the timeline. *Reduce background noise* and *Even out the loudness* are on by default and apply when you export. |
| **Avatar** | Six 3D presenters (Maya, Leo, Priya, Kai, Emma and George), built from scratch in three.js: they blink, glance around and nod, and their mouths move with the voice. Plus 83 photo avatars from the free AI avatar pack (animals, fantasy characters, human archetypes, meme-style characters), each with its own voice clip, which plays under *Hear their voice*. Put any avatar in a corner next to you, or full screen instead of you, where it follows your voice or the dub. Or type a script and press *Make avatar video*: the avatar reads it in a Kokoro voice (for photo avatars, the closest match to their clip), and that recording becomes the video, captioned like any other. The first time downloads the voice model, about 90 MB. |
| **Music** | Search Creative Commons music (Jamendo and others via Openverse, only licences that allow commercial use and changes), preview it, or use your own track. In the export, the music loops, fades out, and dips automatically whenever someone is talking. Its credit is added to the credits list. |
| **Dubbing** | Pick a language (English, Hindi, Spanish, French, German or Arabic). murmurcut translates the captions sentence by sentence with opus-mt, speaks them with Meta's MMS voices, and times each sentence to yours, speeding it up slightly if it runs long. Your voice can stay quietly underneath. It is a generic voice with no lip-sync, and each language downloads about 40–150 MB the first time. |
| **Timeline** | The b-roll, zoom and caption tracks sit under the preview. Click anywhere to jump there, press Space to play or pause, and press Ctrl+Z (or *Undo*) to step back through any edit. |
| **Export** | Renders every frame after the video (and any clip) has reached it, encodes with WebCodecs and saves an MP4 with AAC sound. Nothing drops on a slow machine, and the tab can be in the background. |
| **Captions on green** | Exports only the animated captions on a flat green screen, at the clip's length and 30 fps, with no audio. It renders frame by frame with WebCodecs rather than in real time, so it is frame-accurate even on a slow machine and the tab does not need to stay visible. Key out the green in any editor (CapCut, Premiere, ffmpeg `colorkey`) to lay the captions over a different edit, such as a split screen. |

## Design

The interface follows [`DESIGN.md`](DESIGN.md), a Linear-inspired design system from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT), adapted for an editor. It uses a near-black canvas, graphite surfaces and hairline borders, with lavender reserved for Export, focus and the selected tool. Inter is the interface font and JetBrains Mono shows timecodes. Each timeline track has one tag colour. On a phone, the tool rail becomes a bottom tab bar. The last section of `DESIGN.md` explains how each rule maps onto the editor.

## How it works

```
video ──decodeAudioData(16 kHz)──▶ worker.js  Whisper (WebGPU or CPU): words + timestamps,
                                              plus an English translation pass for b-roll
                                        │
                                        ▼
            captions.js  groupWords · cutRanges · topicOf · planBroll (keyword scoring)
                                        │                       │
                                        │            Wikipedia / Openverse photo search (app.js)
                                        ▼                       ▼
   <video> + clips ──▶ <canvas> ◀── render.js  drawCover · drawSpeaker (split) · drawBroll · drawCaption
                          │ seek, draw, VideoFrame per output frame
                          ▼
   audio ── RNNoise · audio.js cutAudio · levelAudio ── AudioEncoder ─┐
                     VideoEncoder ──────────────────────────────────┴──▶ mp4-muxer ──▶ .mp4
```

- `captions.js`: pure logic for word grouping, edits, script alignment, find and replace, cut ranges and cut-aware time mapping, clip splitting, SRT, keyword scoring and b-roll planning. It has no DOM, so it can be unit tested.
- `audio.js`: pure audio maths for the export: cutting with faded joins, and loudness levelling.
- `render.js`: every caption preset and b-roll layout, drawn on any 2D canvas. The style gallery reuses it.
- `worker.js`: loads Whisper from a CDN and transcribes or translates off the main thread.
- `app.js`: the editor UI, photo search, timeline, cut-aware playback and the exporter.
- `replica/`: the feature research this project was planned from, compiled from public reviews only.

## Tests

```bash
npm test        # caption logic and the chat-to-edit parser
```

`drivers/` holds Puppeteer scripts that drive the app in real Chrome (`cd drivers && npm install` first; serve the app on port 8765 for all but `overlay.mjs`). Each script's first lines give its usage:

- `run.mjs`, `e2e.mjs`: a full edit from import to export, with screenshots
- `green.mjs`: captions exported on a green background
- `overlay.mjs`: captions rendered to a transparent video for ffmpeg
- `audio-fallback.mjs`: makes `decodeAudioData` fail, to test the WebCodecs path iPhone Safari uses

## Limits

- Export seeks the video once per frame, so it takes about as long as the video on a modest laptop.
- Whisper makes mistakes on names and slang, and translation can mishear words ("Skyland" for "skyline"). Fix them with *Fix the words*. *Use my script* spreads your words over the speech evenly, so a script that differs a lot from what you said drifts.
- A video clip plays from one point to another at whatever speed fits its piece; it does not freeze or loop.
- B-roll photos are ranked by meaning with a small on-device model (all-MiniLM-L6-v2). When nothing fits, or the keyword is something a photo cannot show (a website, a company, a score), you get a text card such as "Metacritic 84" instead of a wrong photo. Free photo libraries do not have everything, so use Swap photo, change the search word, or upload your own.
- Without WebGPU, the Accurate model on a CPU can take several minutes per minute of video.

## Not included

Avatars from the pack that copy existing characters or real people or pets (Pepe, Doge, Garfield, Grumpy Cat, Nyan Cat, Trollface and similar) are not published, whatever the pack's licence says.

Eye-contact correction is left out on purpose: the good versions are proprietary, and no open model runs well in a browser.

murmurcut covers the captioning and cutting loop. It does not include AI avatars, eye-contact correction, dubbing or voice cloning, a music library or cloud sync.

murmurcut is an independent project. It is not affiliated with or endorsed by Captions LLC or any other video app. No third-party code, assets or branding are used.

## License

MIT
