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

This needs Playwright's Chromium and ffmpeg under `%LOCALAPPDATA%\ms-playwright`, or `BROWSER` and `FFMPEG` set. The scenes are in `scripts/howto/scenes.mjs`. They work out positions from the editor at record time, so an upstream change to these regions can change what a video shows; re-read the transcript against the video after recording.
