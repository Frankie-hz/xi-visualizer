// node scripts/howto/voice.mjs [scene...]       narrates and tightens the recorded videos
// node scripts/howto/voice.mjs --voices [id...]  one line in each English voice, to pick from
//
// Narrates the HOWTO videos with Kokoro, locally: each cue of a scene's .vtt is spoken on its own
// and laid down at the cue's start, so the voice cannot drift from the picture. A line that runs
// past its slot is spoken again a little faster, up to MAX_SPEED. Then the dead air goes: wherever
// the picture holds still and nobody is talking, the pause is cut down to KEEP. Writes, next to the
// recording in docs/howto/: <scene>.narrated.mp4, its subtitles <scene>.narrated.vtt, and the bare
// voice track <scene>.narration.wav. VOICE picks the voice, am_echo by default.
import ffmpeg from "ffmpeg-static";
import { KokoroTTS } from "kokoro-js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../../docs/howto/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const VOICE = process.env.VOICE ?? "am_echo";
const MAX_SPEED = 1.2;
const GAP = 0.15; // seconds kept between two lines when one has to wait for the other
const KEEP = 0.5; // what is left of a still, silent stretch
const SPEECH_PAD = [0.2, 0.35]; // still frames kept before and after each line

const seconds = stamp => {
  const [h, m, s] = stamp.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
const stamp = s => {
  const ms = Math.round(s * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${
    String(Math.floor(ms / 1000) % 60).padStart(2, "0")
  }.${String(ms % 1000).padStart(3, "0")}`;
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

/** Runs ffmpeg and hands back what it printed, which is where its filters report. */
const run = args =>
  new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    p.stderr.on("data", d => (log += d));
    p.on("error", reject);
    p.on("close", code => (code ? reject(new Error(`ffmpeg exited ${code}\n${log.slice(-2000)}`)) : resolve(log)));
  });

/** Stretches where the picture does not change, with blips shorter than `bridge` ignored. */
async function stills(video, bridge = 0.35) {
  const log = await run(["-i", video, "-vf", "freezedetect=n=0.001:d=0.5", "-an", "-f", "null", "-"]);
  const [, h, m, s] = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const length = Number(h) * 3600 + Number(m) * 60 + Number(s);
  const starts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map(x => Number(x[1]));
  const ends = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map(x => Number(x[1]));
  const merged = [];
  starts.forEach((from, i) => {
    const to = ends[i] ?? length;
    const last = merged.at(-1);
    if (last && from - last[1] < bridge) last[1] = to;
    else merged.push([from, to]);
  });
  return { length, merged };
}

/** `spans` with every interval of `minus` taken out of them. */
const subtract = (spans, minus) =>
  spans.flatMap(([a, b]) => {
    let pieces = [[a, b]];
    for (const [c, d] of minus) pieces = pieces.flatMap(([x, y]) => (d <= x || c >= y ? [[x, y]] : [...(c > x ? [[x, c]] : []), ...(d < y ? [[d, y]] : [])]));
    return pieces;
  });

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });

/** Speaks a line, faster when it would not fit `slot` seconds. */
async function say(text, voice, slot = Infinity) {
  let speed = 1;
  let audio = await tts.generate(text, { voice, speed });
  let length = audio.audio.length / audio.sampling_rate;
  // Kokoro's speed is not quite proportional, so a second go may still be a hair long.
  for (let tries = 0; length > slot && speed < MAX_SPEED && tries < 3; tries++) {
    speed = Math.min(MAX_SPEED, speed * (length / slot) * 1.03);
    audio = await tts.generate(text, { voice, speed });
    length = audio.audio.length / audio.sampling_rate;
  }
  return { samples: audio.audio, rate: audio.sampling_rate, length, speed };
}

const args = process.argv.slice(2);

if (args[0] === "--voices") {
  // Each voice says its own name, then the same line, into one file to listen through and one each.
  const LINE = "Select the region, here east three-ten. Hover Ring all to preview everything it would cut, then click it, and each obstacle becomes a hole.";
  const english = Object.keys(tts.voices).filter(v => /^[ab][fm]_/.test(v));
  const voices = args.length > 1 ? args.slice(1) : english;
  const out = join(DIR, "voices");
  mkdirSync(out, { recursive: true });
  const all = [];
  let rate = 24000;
  for (const v of voices) {
    const [accent, sex] = [v[0] === "a" ? "American" : "British", v[1] === "f" ? "female" : "male"];
    const name = await say(`${v.slice(3)}. ${accent} ${sex}.`, v);
    const line = await say(LINE, v);
    rate = line.rate;
    writeFileSync(join(out, `${v}.wav`), wav(line.samples, rate));
    all.push(name.samples, new Float32Array(rate * 0.4), line.samples, new Float32Array(rate * 1.2));
    console.log(`  ${v}  ${line.length.toFixed(1)}s`);
  }
  const joined = new Float32Array(all.reduce((n, a) => n + a.length, 0));
  all.reduce((at, a) => (joined.set(a, at), at + a.length), 0);
  writeFileSync(join(out, "all-voices.wav"), wav(joined, rate));
  console.log(`wrote ${voices.length} voices to docs/howto/voices/, and all-voices.wav to hear them in a row`);
  process.exit(0);
}

const scenes = readdirSync(DIR)
  .filter(f => f.endsWith(".vtt") && !f.includes(".narrated."))
  .map(f => f.slice(0, -4))
  .filter(id => !args.length || args.includes(id));

for (const id of scenes) {
  const video = join(DIR, `${id}.webm`);
  if (!existsSync(video)) {
    console.log(`${id}: no ${id}.webm, record it first`);
    continue;
  }
  console.log(`${id}`);
  const list = cues(readFileSync(join(DIR, `${id}.vtt`), "utf8"));

  // The voice, on the recording's own timeline.
  const clips = [];
  let rate = 24000;
  let free = 0; // where the previous line ends
  for (const [i, cue] of list.entries()) {
    const slot = (list[i + 1]?.from ?? cue.to) - cue.from - GAP;
    const spoken = await say(cue.text, VOICE, slot);
    rate = spoken.rate;
    const at = Math.max(cue.from, free);
    free = at + spoken.length + GAP;
    clips.push({ at, ...spoken, text: cue.text });
    const late = at - cue.from;
    console.log(
      `  ${cue.from.toFixed(1).padStart(6)}s  ${spoken.length.toFixed(1)}s of ${slot.toFixed(1)}s${spoken.speed > 1 ? `  at ${spoken.speed.toFixed(2)}x` : ""}${
        late > 0.05 ? `  starts ${late.toFixed(1)}s late` : ""
      }`,
    );
  }

  // What to cut: still and silent for longer than KEEP, keeping half of KEEP at either end so a
  // cut never lands right on the end of a movement or the start of a line.
  const { length, merged } = await stills(video);
  const talking = clips.map(c => [c.at - SPEECH_PAD[0], c.at + c.length + SPEECH_PAD[1]]);
  const cuts = subtract(merged, talking)
    .filter(([a, b]) => b - a > KEEP + 0.2)
    .map(([a, b]) => [a + KEEP / 2, b - KEEP / 2]);
  const removed = cuts.reduce((n, [a, b]) => n + b - a, 0);
  /** Where a moment of the recording lands once the cuts are made. */
  const moved = t => t - cuts.reduce((n, [a, b]) => n + Math.max(0, Math.min(t, b) - a), 0);
  const keep = subtract([[0, length]], cuts);
  console.log(`  cut ${cuts.length} pauses, ${removed.toFixed(0)}s: ${length.toFixed(0)}s down to ${(length - removed).toFixed(0)}s`);

  const total = new Float32Array(Math.ceil((length - removed) * rate));
  for (const c of clips) total.set(c.samples.subarray(0, Math.max(0, total.length - Math.round(moved(c.at) * rate))), Math.round(moved(c.at) * rate));
  const track = join(DIR, `${id}.narration.wav`);
  writeFileSync(track, wav(total, rate));
  writeFileSync(
    join(DIR, `${id}.narrated.vtt`),
    `WEBVTT\n\n${clips.map((c, i) => `${i + 1}\n${stamp(moved(c.at))} --> ${stamp(moved(c.at) + c.length)}\n${c.text}\n`).join("\n")}`,
  );

  const select = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");
  await run([
    "-y",
    "-i",
    video,
    "-i",
    track,
    "-filter_complex",
    `[0:v]select='${select}',setpts=N/FRAME_RATE/TB[v]`,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    join(DIR, `${id}.narrated.mp4`),
  ]);
  console.log(`  wrote ${id}.narrated.mp4 and ${id}.narrated.vtt`);
}
