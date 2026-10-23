# murmurcut

**Free, private AI captions, b-roll and jump cuts for talking-head videos. Everything runs in your browser.**

**▶ Try it: https://002478186.github.io/murmurcut/**

Drop in a talking clip and murmurcut does five things:

1. **Captions.** It transcribes the clip with word-level timestamps, using OpenAI's Whisper running locally through [transformers.js](https://github.com/huggingface/transformers.js). It can also translate the speech to English: talk in Hindi, Hinglish or 13 other languages and get English captions.
2. **Styles.** It animates the captions word by word in one of 10 styles: Spotlight, Pop, Beast, Bounce, Karaoke, Sunset, Neon, Outline, Typewriter or Minimal. Spotlight is the talking-head look of small lead-in words over one big italic keyword, placed off-centre and blurred in.
3. **B-roll.** It works out what you are talking about (names, products, places, numbers) and places a photo on each main point. A photo can fill the screen, sit on a card over you, or float with you blurred behind it. The photos come from Wikipedia and Openverse, and every one is credited.
4. **Smart cuts.** It removes filler words and pauses, or any word you click, and adds a punch-in zoom every few lines.
5. **Export.** It saves an MP4 with everything burned in, plus an `.srt` file.

There is no account, no watermark, no credits and no upload: your video never leaves your machine. The only data sent anywhere is the photo search words.

## Run it

It is a static site with no build step. Serve the folder over HTTP, because module workers do not load from `file://`:

```bash
npm start            # or: python -m http.server 8000
```

Open the printed URL in Chrome or Edge. Firefox works, but it exports WebM only.

The first transcription downloads the Whisper model; Accurate is the bigger download. The browser caches it after that. murmurcut runs Whisper on your GPU through WebGPU when the browser supports it, and falls back to the much slower CPU otherwise.

## How to use it

| Step | What happens |
| --- | --- |
| **Import** | Drop in a video or click to choose one. MP4 (H.264) or WebM work best. |
| **Captions** | Pick the spoken language, and whether the captions should stay in it or be translated to English. Hindi gives the best results with English captions, because Whisper's Hindi transcription is unreliable. |
| **Style** | Every preset previews itself live. Then set the size, the position, the capitalisation and the punch-in zoom. |
| **B-roll** | Each moment shows its photo, time and search word. Change the search, swap to the next photo, upload your own, choose how it appears, or add a new moment at the playhead. Copy the photo credits into your video description. |
| **Cuts** | Remove `um`/`uh` fillers and pauses longer than a length you choose. Click any word in Captions to cut it. Cut parts show in red on the timeline. |
| **Timeline** | The b-roll and caption tracks sit under the preview. Click anywhere to jump there, and press Space to play or pause. |
| **Export** | Renders in real time and saves an MP4 where the browser supports it, otherwise WebM. Keep the tab visible while it renders. |

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
   <video> ──▶ <canvas> ◀── render.js  drawCover (zoom) · drawBroll · drawCaption (10 presets)
                  │  captureStream + Web Audio
                  ▼
            MediaRecorder ──▶ .mp4 / .webm
```

- `captions.js`: pure logic for word grouping, edits, cut ranges, SRT, keyword scoring and b-roll planning. It has no DOM, so it can be unit tested.
- `render.js`: every caption preset and b-roll layout, drawn on any 2D canvas. The style gallery reuses it.
- `worker.js`: loads Whisper from a CDN and transcribes or translates off the main thread.
- `app.js`: the editor UI, photo search, timeline, cut-aware playback and the exporter.
- `replica/`: the feature research this project was planned from, compiled from public reviews only.

## Tests

```bash
npm test
```

## Limits

- Export runs in real time and needs the tab in the foreground, because it records the canvas while the video plays.
- The SRT export uses the original timings, so it matches the uncut video.
- Whisper makes mistakes on names and slang, and translation can mishear words ("Skyland" for "skyline"). Fix them in the transcript.
- B-roll picks the right *topic* most of the time, but free photo libraries do not have everything. Game modes and memes are the hardest. Use Swap photo, change the search word, or upload your own.
- Without WebGPU, the Accurate model on a CPU can take several minutes per minute of video.

## Not included

murmurcut covers the captioning and cutting loop. It does not include AI avatars, eye-contact correction, dubbing or voice cloning, a music library or cloud sync.

murmurcut is an independent project. It is not affiliated with or endorsed by Captions LLC or any other video app. No third-party code, assets or branding are used.

## License

MIT
