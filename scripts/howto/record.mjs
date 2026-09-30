// node scripts/howto/record.mjs [scene...]   (needs `pnpm dev` running, zones read from upstream)
//
// Records the HOWTO videos: drives the regions editor in a real browser, scene by scene, and
// writes for each a .webm, a .vtt of the narration cues and a .md transcript, into docs/howto/.
// Every step says what it does and does it; a step lasts at least as long as its line takes to
// read aloud, so a voice laid over the video later has room. Scenes live in ./scenes.mjs.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { SCENES } from "./scenes.mjs";

const BASE = process.env.URL ?? "http://localhost:3000/xi-visualizer/#";
const OUT = new URL("../../docs/howto/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const SIZE = { width: 1920, height: 1080 };
const FPS = 30;
const WORDS_PER_SECOND = 2.5; // an unhurried narrator

const PLAYWRIGHT = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const find = (prefix, file) =>
  existsSync(PLAYWRIGHT) ? readdirSync(PLAYWRIGHT).filter(d => d.startsWith(prefix)).map(d => join(PLAYWRIGHT, d, file)).find(existsSync) : undefined;
const BROWSER = process.env.BROWSER ?? find("chromium-", "chrome-win64/chrome.exe");
const FFMPEG = process.env.FFMPEG ?? find("ffmpeg-", "ffmpeg-win64.exe") ?? "ffmpeg";

const settle = ms => new Promise(r => setTimeout(r, ms));

// A cursor the video can see, since a headless browser draws none, and a ripple where it clicks.
const CURSOR = `
(() => {
  const style = document.createElement("style");
  style.textContent = \`
    #howto-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 28px; height: 28px; margin: -3px 0 0 -4px;
      transition: transform 80ms; transform-origin: 4px 3px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
    #howto-cursor.down { transform: scale(0.85); }
    .howto-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px;
      border: 3px solid #fde047; border-radius: 50%; animation: howto-ripple 550ms ease-out forwards; }
    .howto-ripple.right { border-color: #38bdf8; }
    @keyframes howto-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
  \`;
  document.head.appendChild(style);
  const cursor = document.createElement("div");
  cursor.id = "howto-cursor";
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="white" stroke="black" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  addEventListener("mousemove", e => (cursor.style.left = e.clientX + "px", cursor.style.top = e.clientY + "px"), true);
  addEventListener("mousedown", e => {
    cursor.classList.add("down");
    const ripple = document.createElement("div");
    ripple.className = "howto-ripple" + (e.button === 2 ? " right" : "");
    ripple.style.left = e.clientX + "px";
    ripple.style.top = e.clientY + "px";
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }, true);
  addEventListener("mouseup", () => cursor.classList.remove("down"), true);
})();
`;

/** The things a scene does, with the pointer moving there first, the way a person would. */
function actions(page) {
  let at = { x: SIZE.width / 2, y: SIZE.height / 2 };
  const ease = t => t * t * (3 - 2 * t);
  const api = {
    page,
    settle,
    editor: fn => page.evaluate(fn),
    async move(x, y, ms = 700) {
      const from = at, steps = Math.max(1, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps);
        await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        await settle(ms / steps);
      }
      at = { x, y };
    },
    async click(x, y, button = "left") {
      await api.move(x, y);
      await page.mouse.down({ button });
      await settle(90);
      await page.mouse.up({ button });
      await settle(250);
    },
    async drag(from, to, ms = 1200) {
      await api.move(from.x, from.y);
      await page.mouse.down();
      await settle(150);
      await api.move(to.x, to.y, ms);
      await settle(150);
      await page.mouse.up();
      await settle(300);
    },
    /** The middle of the first element matching, optionally by its text, in page pixels. */
    async where(selector, text) {
      const box = await page.evaluate(
        (selector, text) => {
          const el = [...document.querySelectorAll(selector)].find(e => !text || e.innerText?.trim().startsWith(text) || e.value === text || e.title === text);
          if (!el) return null;
          el.scrollIntoView({ block: "nearest" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        selector,
        text,
      );
      if (!box) throw new Error(`nothing matches ${selector} ${text ?? ""}`);
      return box;
    },
    async press(selector, text) {
      const p = await api.where(selector, text);
      await api.click(p.x, p.y);
    },
    async hover(selector, text, ms) {
      const p = await api.where(selector, text);
      await api.move(p.x, p.y, ms);
    },
    async key(key, modifier) {
      if (modifier) await page.keyboard.down(modifier);
      await page.keyboard.press(key);
      if (modifier) await page.keyboard.up(modifier);
      await settle(300);
    },
    /** Screen position of a zone point. */
    project: (x, y, z) => page.evaluate((x, y, z) => window.__regionEditor.project(x, y, z), x, y, z),
    async open(zone) {
      await page.goto(`${BASE}/regions/${zone}`, { waitUntil: "domcontentloaded" });
      for (let i = 0; i < 90 && !(await page.evaluate(() => !!window.__regionEditor)); i++) await settle(1000);
      await page.evaluate(CURSOR);
      await settle(5000); // roam data and labels
    },
  };
  return api;
}

/** Frames from the screencast, as they come, with the time each was drawn. */
async function capture(page) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp, jpeg: Buffer.from(data, "base64") });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await cdp.send("Page.stopScreencast");
      await cdp.detach();
    },
  };
}

/**
 * The frames at a steady rate, each moment showing the latest frame drawn by then. The ffmpeg that
 * ships with Playwright reads no pipe, so the frames go through a file of JPEGs laid end to end.
 */
function encode(frames, from, to, file) {
  const joined = `${file}.mjpeg`;
  const out = openSync(joined, "w");
  let i = 0;
  for (let t = from; t <= to; t += 1 / FPS) {
    while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
    writeSync(out, frames[i].jpeg);
  }
  closeSync(out);
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG, [
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-framerate",
      String(FPS),
      "-i",
      joined,
      "-c:v",
      "libvpx",
      "-b:v",
      "8M",
      "-crf",
      "8",
      "-deadline",
      "good",
      "-auto-alt-ref",
      "0",
      file,
    ], { stdio: ["ignore", "ignore", "inherit"] });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", code => {
      rmSync(joined, { force: true });
      code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve();
    });
  });
}

const stamp = s => {
  const ms = Math.round(s * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${
    String(Math.floor(ms / 1000) % 60).padStart(2, "0")
  }.${String(ms % 1000).padStart(3, "0")}`;
};

async function record(scene, browser) {
  const page = await browser.newPage();
  await page.setViewport(SIZE);
  page.on("pageerror", e => console.error(`  page error: ${e.message}`));
  const act = actions(page);
  await act.open(scene.zone);
  if (scene.prepare) await scene.prepare(act);

  const video = await capture(page);
  await settle(500);
  const start = video.frames[0]?.t ?? Date.now() / 1000;
  const cues = [];
  for (const step of scene.steps) {
    const began = Date.now() / 1000;
    await step.do?.(act);
    // Room for the line to be said, however quick the action was.
    const need = step.say ? step.say.split(/\s+/).length / WORDS_PER_SECOND + 0.6 : 0;
    const left = need - (Date.now() / 1000 - began);
    if (left > 0) await settle(left * 1000);
    if (step.hold) await settle(step.hold);
    if (step.say) cues.push({ from: began - start, to: Date.now() / 1000 - start, text: step.say });
    console.log(`  ${stamp(began - start)} ${step.say ?? "(silent)"}`.slice(0, 120));
  }
  await settle(800);
  await video.stop();
  const end = video.frames.at(-1).t + 0.8;

  mkdirSync(OUT, { recursive: true });
  await encode(video.frames, start, end, join(OUT, `${scene.id}.webm`));
  writeFileSync(join(OUT, `${scene.id}.vtt`), `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.text}\n`).join("\n")}`);
  writeFileSync(
    join(OUT, `${scene.id}.md`),
    `# ${scene.title}\n\n${scene.summary}\n\nZone: ${scene.zone}. Video: [${scene.id}.webm](${scene.id}.webm), cues: [${scene.id}.vtt](${scene.id}.vtt).\n\n| At | Narration |\n| --- | --- |\n${
      cues.map(c => `| ${stamp(c.from).slice(3, 8)} | ${c.text} |`).join("\n")
    }\n`,
  );
  await page.close();
  return { id: scene.id, seconds: end - start, cues: cues.length };
}

const wanted = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: "new",
  // The real GPU: software rendering manages a few frames a second, which is no video at all.
  args: ["--no-sandbox", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", `--window-size=${SIZE.width},${SIZE.height}`],
});
try {
  for (const scene of SCENES.filter(s => !wanted.length || wanted.includes(s.id))) {
    console.log(`${scene.id}: ${scene.title}`);
    const done = await record(scene, browser);
    console.log(`  wrote ${done.id}.webm, ${done.seconds.toFixed(0)}s, ${done.cues} cues`);
  }
} finally {
  await browser.close();
}
