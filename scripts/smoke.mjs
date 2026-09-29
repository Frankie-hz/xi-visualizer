// pnpm smoke  (builds first: pnpm build && pnpm smoke)
//
// Drives the regions editor in a real browser and asserts the things that would otherwise only
// break in front of someone. vite strips types without running the app, so a signal deleted by
// mistake still builds and still ships; this is what notices.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = 5188;
const URL = `http://localhost:${PORT}/xi-visualizer/#/regions/west_ronfaure`;
const ZONE_READY = 20000; // the zone mesh and a few MB of roam data have to arrive first

const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browserPath = BROWSERS.find(p => existsSync(p));
if (!browserPath) {
  console.error("No browser found. Set BROWSER to a chrome or edge executable.");
  process.exit(1);
}

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);

const settle = ms => new Promise(r => setTimeout(r, ms));
await settle(4000);

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

const errors = [];
page.on("pageerror", e => errors.push(e.message.split("\n")[0]));

const text = () => page.evaluate(() => document.body.innerText);
const rows = () => page.evaluate(() => document.querySelectorAll('div[title*="click to keep its trail"]').length);
const menu = () =>
  page.evaluate(() => {
    const el = document.querySelector('[role="menu"]');
    return el ? el.innerText.replace(/\n/g, " | ") : null;
  });
const clickMenu = pattern =>
  page.evaluate(p => {
    const el = document.querySelector('[role="menu"]');
    [...el.querySelectorAll("button")].find(b => new RegExp(p).test(b.innerText)).click();
  }, pattern);
const label = name =>
  page.evaluate(n => {
    const el = [...document.querySelectorAll('div[title*="right-click for more"]')].find(d => d.style.display === "block" && d.innerText.startsWith(n));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, name);
const tally = () => text().then(t => Object.fromEntries(t.split("\n").flatMap(l => [...l.matchAll(/^(\w+) \((\d+)\)$/g)].map(m => [m[1], +m[2]]))));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);

  // the shell
  const counts = await tally();
  assert.ok(counts.Regions > 0, `regions loaded, got ${JSON.stringify(counts)}`);
  assert.ok(await rows(), "the mob list rendered its rows");
  assert.match(await text(), /All 602/, "the status chips counted every spawn");

  // hovering a mob row, the path that broke silently once before
  const row = await page.evaluate(() => {
    const el = document.querySelector('div[title*="click to keep its trail"]');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) };
  });
  await page.mouse.move(row.x, row.y);
  await settle(400);

  // a region converts to a patrol, and undo puts it back
  const before = await tally();
  const at = await label("e_46");
  assert.ok(at, "found a region label on the map");
  await page.mouse.click(at.x, at.y, { button: "right" });
  await settle(400);
  assert.match(await menu(), /Convert to patrol/, "the region menu opened");
  await clickMenu("Convert to patrol");
  await settle(2500);

  const after = await tally();
  assert.ok(after.Routes > before.Routes, `the routes exist, got ${after.Routes} from ${before.Routes}`);
  assert.strictEqual(after.Regions, before.Regions - 1, "the region it replaced is gone");
  assert.match(await text(), /Editing patrol for/, "the banner says what is being edited");

  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await settle(800);
  assert.deepStrictEqual(await tally(), before, "undo put the zone back exactly as it was");
  assert.doesNotMatch(await text(), /Editing patrol for/, "and stopped editing what it removed");

  // backing out of a new region leaves neither an empty row nor a step in History
  const press = label => page.evaluate(l => [...document.querySelectorAll("button")].find(b => b.innerText.startsWith(l)).click(), label);
  await press("Regions (");
  await press("+ Region");
  await settle(300);
  await page.keyboard.press("Escape");
  await settle(300);
  assert.deepStrictEqual(await tally(), before, "Esc on an undrawn region took it away again");

  // reviewing: the same menu offers nothing that changes the zone, and a click still selects
  await page.goto(`${URL}?review=1`, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  const seen = await label("e_46");
  assert.ok(seen, "found the region label while reviewing");
  await page.mouse.click(seen.x, seen.y, { button: "right" });
  await settle(400);
  const offered = await menu();
  assert.match(offered, /Centre on it/, "the region menu opened while reviewing");
  assert.doesNotMatch(offered, /Convert|Repair|Delete/, "and offers no edits");
  await page.keyboard.press("Escape");
  await page.mouse.click(seen.x, seen.y);
  await settle(600);
  assert.match(await text(), /Viewing region e_46/, "clicking a label selects the region");

  // an edit made just before leaving is in the draft when the zone opens again
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  const again = await label("e_46");
  await page.mouse.click(again.x, again.y, { button: "right" });
  await settle(400);
  await clickMenu("Convert to patrol");
  await settle(100); // well inside the autosave debounce
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  assert.match(await text(), /Unsaved work on west_ronfaure/, "the edit survived the reload");
  await press("Discard");

  assert.deepStrictEqual(errors, [], "no errors on the page");
  console.log("ok");
} catch (e) {
  console.error("FAILED:", e.message);
  if (errors.length) console.error("page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}
