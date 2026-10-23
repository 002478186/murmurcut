# Recon map: Captions (captions.ai)

Clean-room recon from public sources only: third-party reviews and directory listings. No account was used, no app code was read and no network traffic was logged. Screenshots were not collected.

## Scope

- **App:** Captions by Captions LLC, on iOS, Android and web.
- **Slice:** the core loop people pay for. You upload a talking-head video, it is transcribed automatically, you style the animated word-by-word captions, cut out fillers and silences, and export the result.
- **For:** personal use, a free and private alternative that runs fully in the browser.

## Sources

| source | what it gave |
| --- | --- |
| https://www.eesel.ai/blog/captions-ai-pricing | tiers and credit gating |
| https://sendshort.ai/guides/captions-review/ | feature list and Whisper-based transcription |
| https://quso.ai/blog/captions-ai-review-best-online-video-editor.html | AI Edit, smart cuts, styles |
| https://www.capterra.com/p/10014909/Captions/ | user-reported features and complaints |
| https://www.getapp.com/all-software/a/captions/ | feature directory |

## Screens

| ID | screen | how you get there | purpose | key components | states |
| --- | --- | --- | --- | --- | --- |
| S01 | Projects / home | app launch | start or open a project | upload button, project grid | empty, filled |
| S02 | Import | "new project" | pick a video | file picker, drop zone | empty, loading, error (bad file) |
| S03 | Transcribing | after import | generate captions | progress bar, language picker | loading, error |
| S04 | Editor | after transcription | preview with captions over the video | canvas preview, play/seek, transcript list | playing, paused, no captions |
| S05 | Caption styles | editor tab | choose a look | preset grid, size, position, case | selected |
| S06 | Transcript edit | editor tab | fix words, cut words | line rows, word chips | edited, cut |
| S07 | Smart cuts / AI Edit | editor tab | remove fillers and silences | toggles, threshold | on, off |
| S08 | Export | export button | render and save | progress, download | rendering, done, error |
| S09 | Paywall | gated feature | upsell | plan cards | n/a (not cloned) |

## Flows

```
F01 Creator captions a video
    S02 import -> S03 transcribe -> S04 preview -> S05 pick style -> S08 export
    happy path: 4 clicks (import, transcribe, style, export)
    edge: no speech in the video, very long video, unsupported codec, non-English speech

F02 Creator fixes a misheard word
    S04 -> S06 edit line text -> S04 preview
    edge: the edit changes the word count, so timings must be redistributed

F03 Creator tightens the edit
    S04 -> S07 enable filler and silence cuts (or click words to cut) -> S04 preview -> S08 export
    edge: a cut at the very start or end, overlapping cuts

F04 Creator exports subtitles only
    S04 -> S08 download .srt
```

## Components

| name | variants | states | screens |
| --- | --- | --- | --- |
| button | primary, ghost | default, disabled, busy | all |
| drop zone | n/a | empty, drag-over | S02 |
| progress bar | n/a | indeterminate, percentage | S03, S08 |
| preset card | one per style | default, selected | S05 |
| slider | n/a | n/a | S05, S07 |
| word chip | n/a | normal, active (playing), cut | S06 |
| line row | n/a | normal, editing | S06 |

## Inferred data model

```
Project  video file, language, style settings, lines[]
         evidence: the editor keeps one video with its captions. confidence: high
Line     start, end, words[]
         evidence: captions show 2-5 words at a time. confidence: high
Word     text, start, end, cut (bool)
         evidence: word-by-word highlight, and the help copy on removing words. confidence: high
Style    preset, font size, y position, uppercase
         evidence: style picker reviews. confidence: medium (the real app has many more knobs)
```

## What cannot be cloned (skip)

- AI avatars / AI Creator: they need trained avatar models and licensed likenesses.
- Eye-contact correction, AI dubbing, voice cloning, background removal: each one needs a heavy proprietary or hosted model.
- The 100+ branded caption styles, fonts and music library: these are licensed or owned assets. murmurcut ships its own 4 presets.
- Accounts, cloud sync, the team workspace and payments: out of scope for a local, free tool.

## Size

9 screens (8 cloned), 4 flows, 3 entities. The hard parts are in-browser speech recognition with word timestamps, frame-accurate caption rendering, and exporting with the cuts applied without a server. Size: **S** for this slice, run entirely client-side.
