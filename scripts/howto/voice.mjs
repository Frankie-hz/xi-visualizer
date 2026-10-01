// node scripts/howto/voice.mjs [scene...]   (after record.mjs; VOICE=af_heart by default)
//
// Narrates the HOWTO videos with Kokoro, locally: each cue of a scene's .vtt is spoken on its own
// and laid down at the cue's start, so the voice cannot drift from the picture. A line that runs
// past its slot is spoken again a little faster, up to MAX_SPEED. Writes <scene>.narration.wav and
// <scene>.narrated.webm (the video with that track) next to the recording in docs/howto/.
import ffmpeg from "ffmpeg-static";
import { KokoroTTS } from "kokoro-js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../../docs/howto/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const VOICE = process.env.VOICE ?? "af_heart";
const MAX_SPEED = 1.2;
const GAP = 0.15; // seconds kept between two lines when one has to wait for the other

const seconds = stamp => {
  const [h, m, s] = stamp.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/** The cues of a WEBVTT file as written by record.mjs: index, timing, one line of text. */
const cues = text =>
  text.split(/\r?\n\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex(l => l.includes("-->"));
    if (timing < 0) return [];
    const [from, to] = lines[timing].split("-->").map(s => seconds(s.trim()));
    return [{ from, to, text: lines.slice(timing + 1).join(" ").trim() }];
  });

/** 16-bit mono PCM, the plainest thing ffmpeg and any editor will take. */
function wav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return out;
}

const run = args =>
  new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", reject);
    p.on("close", code => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve()));
  });

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });

const wanted = process.argv.slice(2);
const scenes = readdirSync(DIR)
  .filter(f => f.endsWith(".vtt"))
  .map(f => f.slice(0, -4))
  .filter(id => !wanted.length || wanted.includes(id));

for (const id of scenes) {
  const video = join(DIR, `${id}.webm`);
  if (!existsSync(video)) {
    console.log(`${id}: no ${id}.webm, record it first`);
    continue;
  }
  console.log(`${id}`);
  const list = cues(readFileSync(join(DIR, `${id}.vtt`), "utf8"));
  const clips = [];
  let rate = 24000;
  let free = 0; // where the previous line ends
  for (const [i, cue] of list.entries()) {
    const slot = (list[i + 1]?.from ?? cue.to) - cue.from - GAP;
    let speed = 1;
    let audio = await tts.generate(cue.text, { voice: VOICE, speed });
    rate = audio.sampling_rate;
    let length = audio.audio.length / rate;
    // Kokoro's speed is not quite proportional, so a second go may still be a hair long.
    for (let tries = 0; length > slot && speed < MAX_SPEED && tries < 3; tries++) {
      speed = Math.min(MAX_SPEED, speed * (length / slot) * 1.03);
      audio = await tts.generate(cue.text, { voice: VOICE, speed });
      length = audio.audio.length / rate;
    }
    const at = Math.max(cue.from, free);
    free = at + length + GAP;
    clips.push({ at, samples: audio.audio });
    const late = at - cue.from;
    console.log(
      `  ${cue.from.toFixed(1).padStart(6)}s  ${length.toFixed(1)}s of ${slot.toFixed(1)}s${speed > 1 ? `  at ${speed.toFixed(2)}x` : ""}${
        late > 0.05 ? `  starts ${late.toFixed(1)}s late` : ""
      }`,
    );
  }
  const total = new Float32Array(Math.ceil(free * rate));
  for (const c of clips) total.set(c.samples, Math.round(c.at * rate));
  const track = join(DIR, `${id}.narration.wav`);
  writeFileSync(track, wav(total, rate));
  await run([
    "-y",
    "-loglevel",
    "error",
    "-i",
    video,
    "-i",
    track,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "128k",
    join(DIR, `${id}.narrated.webm`),
  ]);
  console.log(`  wrote ${id}.narrated.webm`);
}
