# murmurcut

**Free, private AI captions and jump cuts for talking-head videos. Everything runs in your browser.**

Drop in a video and murmurcut does four things:

1. Transcribes it with word-level timestamps, using OpenAI's Whisper running locally through [transformers.js](https://github.com/huggingface/transformers.js).
2. Renders animated word-by-word captions in one of four styles: Pop, Karaoke, Minimal or Neon.
3. Removes filler words and dead air, or any word you click.
4. Exports the finished video with the captions burned in, plus an `.srt` file.

There is no account, no watermark, no credits and no upload: your video never leaves your machine.

## Run it

It is a static site with no build step. Serve the folder over HTTP, because module workers do not load from `file://`:

```bash
npm start            # or: python -m http.server 8000
```

Open the printed URL in Chrome or Edge. Firefox works, but it exports WebM only.

The first transcription downloads the Whisper model (about 150 MB). The browser caches it after that.

## How to use it

| Step | What happens |
| --- | --- |
| **Import** | Drop in a video or click to choose one. MP4 (H.264) or WebM work best. |
| **Generate captions** | Pick the spoken language. Whisper runs in a Web Worker, so the page stays responsive. |
| **Style** | Choose a preset, then set the size, the vertical position and the case. |
| **Edit** | Type into any caption line to fix it. Click a word chip to cut that word from the video. |
| **Smart cuts** | Remove `um`/`uh`-style fillers and silences longer than a threshold you choose. |
| **Export** | Renders in real time. Saves as MP4 where the browser supports it, otherwise WebM. Keep the tab visible while it renders. |

## How it works

```
video ──decodeAudioData(16 kHz)──▶ worker.js (Whisper base, word timestamps)
                                        │ chunks
                                        ▼
                             captions.js  toWords → groupWords → cutRanges
                                        │
   <video> ──drawImage──▶ <canvas> ◀── drawCaption (app.js)
                              │  captureStream + Web Audio
                              ▼
                        MediaRecorder ──▶ .mp4 / .webm
```

- `captions.js`: pure logic covering word grouping, text edits, cut ranges and SRT output. It has no DOM, so it can be unit tested.
- `worker.js`: loads the Whisper pipeline from a CDN and transcribes off the main thread.
- `app.js`: the UI, the canvas caption renderer, cut-aware playback and the exporter.
- `replica/`: the feature research this project was planned from, compiled from public reviews only.

## Tests

```bash
npm test
```

## Limits

- Export runs in real time and needs the tab in the foreground, because it records the canvas while the video plays.
- The SRT export uses the original timings, so it matches the uncut video.
- Whisper `base` is quick but makes mistakes on names and jargon. Fix those in the transcript editor.

## Not included

murmurcut covers the captioning and cutting loop. It does not include AI avatars, eye-contact correction, dubbing or voice cloning, a music library or cloud sync.

murmurcut is an independent project. It is not affiliated with or endorsed by Captions LLC or any other video app. No third-party code, assets or branding are used.

## License

MIT
