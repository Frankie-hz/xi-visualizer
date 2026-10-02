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
  assert.match(await menu(), /Turn into a route/, "the region menu opened");
  await clickMenu("Turn into a route");
  await settle(2500);

  const after = await tally();
  assert.ok(after.Routes > before.Routes, `the routes exist, got ${after.Routes} from ${before.Routes}`);
  assert.strictEqual(after.Regions, before.Regions - 1, "the region it replaced is gone");
  assert.match(await text(), /Editing the route of/, "the banner says what is being edited");

  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await settle(800);
  assert.deepStrictEqual(await tally(), before, "undo put the zone back exactly as it was");
  assert.doesNotMatch(await text(), /Editing the route of/, "and stopped editing what it removed");

  // backing out of a new region leaves neither an empty row nor a step in History
  const press = label => page.evaluate(l => [...document.querySelectorAll("button")].find(b => b.innerText.startsWith(l)).click(), label);
  await press("Regions (");
  await press("+ Region");
  await settle(300);
  await page.keyboard.press("Escape");
  await settle(300);
  assert.deepStrictEqual(await tally(), before, "Esc on an undrawn region took it away again");

  // carving: empty patches are found in the selected region, cutting them is one step, what was cut
  // leaves the list, and undo takes it back
  await page.evaluate(() =>
    [...document.querySelectorAll('div[title*="right-click for more"]')].find(d => d.style.display === "block" && d.innerText.startsWith("e_46")).click()
  );
  await settle(800);
  await press("Carve holes");
  await settle(10000);
  const patches = () => text().then(t => Number(t.match(/Cut patches \((\d+)\)/)?.[1]));
  const found = await patches();
  assert.ok(found > 0, `empty patches were found in e_46, got ${found}`);
  // What Ring all cuts leaves the list: offering it again would cut the same hole twice.
  if (!/Ring all \(0\)/.test(await text())) {
    await press("Ring all");
    await settle(4000);
    assert.match(await text(), /Ring all \(0\)/, "what Ring all cut is not offered again");
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    await settle(1500);
  }
  await press("Cut patches");
  await settle(4000);
  assert.strictEqual((await tally()).History, 1, "cutting them is one step in History");
  const left = await patches();
  assert.ok(left < found, `what was cut left the list, ${found} → ${left}`);
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await settle(1500);
  assert.strictEqual((await tally()).History, 0, "and undo takes it back");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // a plan from the roam data opens from the map's menu, takes the map, and Esc hands it back
  const spot = await label("e_46");
  await page.evaluate(() =>
    [...document.querySelectorAll('div[title*="right-click for more"]')].find(d => d.style.display === "block" && d.innerText.startsWith("e_46")).click()
  );
  await settle(1500);
  await page.mouse.click(spot.x + 40, spot.y + 40, { button: "right" });
  await settle(500);
  const planMenu = (await menu()) ?? "";
  assert.match(planMenu, /roam data/, `the menu inside the region offers a hole from the roam data, got "${planMenu}"`);
  await clickMenu("roam data");
  await settle(1500);
  assert.match(await text(), /Hole from roam data/i, "the plan panel opened");
  await page.keyboard.press("Escape");
  await settle(400);
  assert.doesNotMatch(await text(), /Hole from roam data/i, "and Esc closed it");
  assert.match(await text(), /Editing region e_46/, "leaving the region selected");
  await page.keyboard.press("Escape");

  // a zone of storeys: walls of the floors above and below the region are not obstacles on it
  await page.goto(URL.replace("west_ronfaure", "beadeaux"), { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY + 10000);
  await page.evaluate(() => [...document.querySelectorAll("input")].find(i => i.value === "nw_205").closest("div[tabindex]").click());
  await settle(1500);
  await press("Carve holes");
  await settle(12000);
  const onStorey = Number((await text()).match(/Obstacles · (\d+) found/i)?.[1]);
  assert.ok(onStorey <= 3, `nw_205 in Beadeaux offers only what stands on its own floor, got ${onStorey}`);
  await page.keyboard.press("Escape");
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);

  // reviewing: the same menu offers nothing that changes the zone, and a click still selects
  await page.goto(`${URL}?review=1`, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  const seen = await label("e_46");
  assert.ok(seen, "found the region label while reviewing");
  await page.mouse.click(seen.x, seen.y, { button: "right" });
  await settle(400);
  const offered = await menu();
  assert.match(offered, /Centre on it/, "the region menu opened while reviewing");
  assert.doesNotMatch(offered, /route|Repair|Delete/, "and offers no edits");
  await page.keyboard.press("Escape");
  await page.mouse.click(seen.x, seen.y);
  await settle(600);
  assert.match(await text(), /Viewing region e_46/, "clicking a label selects the region");

  // an edit made just before leaving is put straight back when the zone opens again
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  const again = await label("e_46");
  await page.mouse.click(again.x, again.y, { button: "right" });
  await settle(400);
  await clickMenu("Turn into a route");
  await settle(100); // well inside the autosave debounce
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  assert.match(await text(), /Put back your unsaved edits/, "the edit survived the reload");

  // a pull request opens in the editor on the zone it touched, read only, with its changes listed
  await page.goto(`http://localhost:${PORT}/xi-visualizer/#/regions?pr=11610`, { waitUntil: "domcontentloaded" });
  await settle(ZONE_READY);
  assert.match(await text(), /Implement Spawn Region for Barge Mobs/, "the pull request was found");
  assert.match(page.url(), /regions\/phanauet_channel\?/, "and the zone it touched was opened");
  assert.match(await text(), /Changes \(\d+\)/, "its changes are counted in a tab of their own");
  assert.match(await text(), /added, \d+ vertices/, "and listed");
  assert.doesNotMatch(await text(), /No changes|Sign in to save/, "with nothing to save, since it is read only");

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
