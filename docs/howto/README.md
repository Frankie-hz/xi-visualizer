# Regions editor HOWTOs

Screen recordings of the regions editor fixing real problems in upstream data, with a narration script for each: a `.vtt` of timed cues and a `.md` transcript. Each step lasts at least as long as its line takes to read aloud at 2.5 words a second, so a voice can be laid over the video as is.

| | Zone | Transcript |
| --- | --- | --- |
| Expanding a region's outline | West Ronfaure, nw_112 | [01-expand-outline.md](01-expand-outline.md) |
| Expanding a hole | Jugner Forest, w_76 | [02-expand-hole.md](02-expand-hole.md) |
| Carving holes automatically | Jugner Forest, e_310 | [03-auto-carve.md](03-auto-carve.md) |
| Assigning a mob to a region | Valkurm Dunes, region_39 | [04-assign-mob.md](04-assign-mob.md) |

The videos (`.webm`, 1920×1080, 30 fps) are not committed. To make them, with `pnpm dev` running:

```
node scripts/howto/record.mjs              # all four
node scripts/howto/record.mjs 02-expand-hole
```

Then, to narrate them with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), locally and with no account (the model, about 300 MB, downloads on first use):

```
node scripts/howto/voice.mjs                     # all four; VOICE=bm_george etc. for another voice than am_echo
node scripts/howto/voice.mjs --voices            # the same line in every English voice, to choose one
```

That writes `<scene>.narrated.mp4`, its subtitles `<scene>.narrated.vtt`, and the bare `<scene>.narration.wav` beside each video. Each cue is spoken on its own and placed at its start time, so the voice stays in sync; a line too long for its slot is sped up, up to 1.2×. Then every stretch where the picture holds still and nobody is talking is cut down to half a second. `--voices` writes `voices/<voice>.wav` and `voices/all-voices.wav`, where each voice says its name before the line.

Recording needs Playwright's Chromium and ffmpeg under `%LOCALAPPDATA%\ms-playwright`, or `BROWSER` and `FFMPEG` set. The scenes are in `scripts/howto/scenes.mjs`. They work out positions from the editor at record time, so an upstream change to these regions can change what a video shows; re-read the transcript against the video after recording.
