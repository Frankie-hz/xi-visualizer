// node src/regions.test.ts
import assert from "node:assert";
import {
  commitMessage,
  containsXZ,
  diffRegions,
  emitRegionsBlock,
  floorYAt,
  mergeZone,
  parseMobsYaml,
  parsePastedZone,
  parseRegionsYaml,
  patchMobsYaml,
  patchRegionsYaml,
  placementsFrom,
  placementsOf,
  regionArea,
  regionAt,
  regionDifference,
  regionsFromPoints,
  repairRegion,
  routeFromTrail,
  selfIntersects,
  simplifyLine,
  simplifyRing,
  splitPlacements,
  validate,
  zoneOfMobId,
} from "./regions.ts";
import type { Region, RegionSet, Ring, TrailPoint, Vertex, ZoneSide, ZoneState } from "./regions.ts";

// Two stacked floors sharing the same footprint, ground floor has a hole.
const regions: RegionSet = {
  f1_hall: {
    rings: [
      [[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]],
      [[4, -50, 4], [6, -50, 4], [6, -50, 6], [4, -50, 6]],
    ],
  },
  f2_hall: { rings: [[[0, -70, 0], [10, -70, 0], [10, -70, 10], [0, -70, 10]]] },
};

// --- geometry ---
assert.ok(containsXZ(regions.f1_hall, 1, 1), "inside outline");
assert.ok(!containsXZ(regions.f1_hall, 5, 5), "inside hole is outside");
assert.ok(!containsXZ(regions.f1_hall, 20, 5), "outside outline");
assert.strictEqual(floorYAt(regions.f1_hall, 1, 1), -50);
assert.strictEqual(regionAt(regions, 1, 1, -49), "f1_hall", "nearest floor picks the ground floor");
assert.strictEqual(regionAt(regions, 1, 1, -69), "f2_hall", "nearest floor picks the upper floor");
assert.strictEqual(regionAt(regions, 99, 99, -50), null, "outside everything");

// a small region nested in a bigger one on the same floor has to win, or it can never be clicked
const nested: RegionSet = {
  big: { rings: [[[0, -50, 0], [40, -50, 0], [40, -50, 40], [0, -50, 40]]] },
  small: { rings: [[[10, -50.4, 10], [20, -50.4, 10], [20, -50.4, 20], [10, -50.4, 20]]] },
};
assert.strictEqual(regionAt(nested, 15, 15, -50), "small", "nested region wins inside it");
assert.strictEqual(regionAt(nested, 35, 35, -50), "big", "outside the nested one, the big one wins");
assert.ok(selfIntersects([[0, 0, 0], [10, 0, 10], [10, 0, 0], [0, 0, 10]]), "bowtie");

// simplify drops near-collinear filler, keeps the corners, and never destroys the shape
const noisy = [[0, 0, 0], [5, 0, 0.1], [10, 0, 0], [10, 0, 10], [5, 0, 10.1], [0, 0, 10]] as Ring;
assert.deepStrictEqual(simplifyRing(noisy), [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]], "collinear filler removed");
assert.strictEqual(simplifyRing(noisy, 1000).length, 3, "never goes below a triangle");
assert.strictEqual(simplifyRing(regions.f1_hall.rings[0]).length, 4, "a clean square is left alone");
assert.ok(!selfIntersects(regions.f1_hall.rings[0]), "square is clean");

// --- building a region out of roam points ---
const blob: TrailPoint[] = [];
for (let x = 0; x <= 40; x += 2) {
  for (let z = 0; z <= 40; z += 2) blob.push({ x, y: -50, z });
}
const built = regionsFromPoints(blob)[0];
assert.strictEqual(regionsFromPoints(blob).length, 1, "one cluster, one region");
assert.strictEqual(built.rings.length, 1, "a solid blob has no holes");
assert.ok(built.rings[0].length >= 4 && built.rings[0].length <= 12, `outline stays simple, got ${built.rings[0].length}`);
assert.ok(built.rings[0].every(v => Math.abs(v[1] + 50) < 0.01), "vertex heights come from the points");
const xs = built.rings[0].map(v => v[0]);
const zs = built.rings[0].map(v => v[2]);
assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 40, "outline covers the points in x");
assert.ok(Math.min(...zs) <= 0 && Math.max(...zs) >= 40, "outline covers the points in z");
assert.ok(blob.every(p => containsXZ(built, p.x, p.z)), "every point it was built from is inside it");

// an annulus of points has to come out as an outline plus a hole
const donut: TrailPoint[] = [];
for (let a = 0; a < 360; a += 2) {
  for (let r = 34; r <= 60; r += 2) {
    donut.push({ x: Math.cos((a * Math.PI) / 180) * r, y: -20, z: Math.sin((a * Math.PI) / 180) * r });
  }
}
const ring = regionsFromPoints(donut)[0];
assert.strictEqual(ring.rings.length, 2, "annulus keeps its hole");
assert.ok(!containsXZ(ring, 0, 0), "the middle of the donut is not inside");
assert.ok(containsXZ(ring, 45, 0), "the band itself is inside");
assert.deepStrictEqual(regionsFromPoints([{ x: 0, y: 0, z: 0 }]), [], "not enough points to build anything");

// two camps have to come out as two regions, not one region with the other punched out of it
const camps: TrailPoint[] = [];
for (let x = 0; x <= 30; x += 2) for (let z = 0; z <= 30; z += 2) camps.push({ x, y: -50, z });
for (let x = 200; x <= 240; x += 2) for (let z = 0; z <= 30; z += 2) camps.push({ x, y: -50, z });
const split = regionsFromPoints(camps);
assert.strictEqual(split.length, 2, "two clusters, two regions");
assert.ok(camps.every(p => split.some(r => containsXZ(r, p.x, p.z))), "every point lands in one of them");

// Almost every zone has no regions.yaml at all, so it reads back as "" -- and js-yaml raises
// "expected a document, but the input is empty" for an empty file, a blank one, and one holding
// nothing but its schema comment. None of those is a broken file; they are zones nobody has drawn
// yet, and treating them as failures made 299 of 300 zones refuse to open.
assert.deepStrictEqual(parseRegionsYaml(""), {}, "a zone with no regions.yaml has no regions");
assert.deepStrictEqual(parseRegionsYaml("  \n\n"), {}, "nor does a blank one");
assert.deepStrictEqual(parseRegionsYaml("# yaml-language-server: $schema=x\n"), {}, "nor one with only its header");
// ...but a file that is genuinely malformed still has to say so rather than read as empty
assert.throws(() => parseRegionsYaml("regions: [oops\n"), /deficient indentation|unexpected end/i, "real syntax errors still throw");
assert.throws(() => parseMobsYaml(""), /no `spawns:` section/, "an empty mobs.yaml is a missing section, not a yaml puzzle");

// --- regions.yaml round trip and patching ---
const regionsYaml = `# yaml-language-server: $schema=../../schemas/regions.schema.json

regions:

  old_one:
    poly:
      - [0.00, 0.00, 0.00]
`;
const patched = patchRegionsYaml(regionsYaml, regions);
assert.ok(patched.startsWith("# yaml-language-server:"), "the schema header survives verbatim");
assert.deepStrictEqual(parseRegionsYaml(patched), regions, "regions round-trip through regions.yaml");
assert.strictEqual(patchRegionsYaml(patched, regions), patched, "patching is idempotent");
assert.ok(!patchRegionsYaml(patched, {}).includes("regions:"), "empty region set removes the block");
// most zones have none, so the first region drawn writes the whole file
const fresh = patchRegionsYaml("", regions);
assert.ok(fresh.startsWith("# yaml-language-server: $schema=../../schemas/regions.schema.json\n\nregions:"), "a new file carries its schema");
assert.deepStrictEqual(parseRegionsYaml(fresh), regions, "and parses back");
assert.strictEqual(patchRegionsYaml("", {}), "", "no regions, no file");
assert.match(emitRegionsBlock(regions), /^  f1_hall:$/m);
assert.ok(emitRegionsBlock(regions).indexOf("f1_hall") < emitRegionsBlock(regions).indexOf("f2_hall"), "sorted by name");

// --- mobs.yaml patching ---
const mobsYaml = `# yaml-language-server: $schema=../../schemas/mobs.schema.json
#  spawns:   <- generated reference comment, must not be treated as a section

templates:

  Wild_Rabbit:
    id: 5421

spawns:
  17186822:
    template: Wild_Rabbit
    at:       [-317.406, -52.494, 308.691, 127]
    level:    [1, 1]
  17186823:
    template: Tunnel_Worm
    at:       [1.000, 2.000, 3.000]
    level:    [1, 1]
    region:   stale_region

slots:
  - members:
      17186822: {} # Wild_Rabbit
`;
const positions = Object.fromEntries(parseMobsYaml(mobsYaml).filter(s => s.at).map(s => [s.id, s.at!]));
const assigned = patchMobsYaml(mobsYaml, { "17186822": ["f1_hall"] }, positions);
// the placement key takes the line at: had, and the entry stays aligned to its widest key
assert.match(assigned, /template: Wild_Rabbit\n {4}region: {3}f1_hall\n {4}level: {4}\[1, 1\]\n/, "region replaces the fixed spawn point");
assert.ok(!assigned.includes("-317.406"), "at: removed once a region places it");
assert.ok(!assigned.includes("stale_region"), "assignment dropped when no longer assigned");
assert.ok(assigned.includes("templates:\n\n  Wild_Rabbit:"), "templates untouched");
assert.ok(assigned.includes("slots:\n  - members:\n      17186822: {} # Wild_Rabbit\n"), "later sections untouched");
assert.strictEqual(patchMobsYaml(assigned, { "17186822": ["f1_hall"] }, positions), assigned, "patching is idempotent");

// unassigning puts the coordinates back exactly as they were
assert.strictEqual(patchMobsYaml(assigned, {}, positions), mobsYaml.replace("    region:   stale_region\n", ""), "at: restored on unassign");

const spawns = parseMobsYaml(assigned);
assert.deepStrictEqual(spawns[0], {
  id: "17186822",
  name: "Wild_Rabbit",
  x: 0,
  y: 0,
  z: 0,
  at: undefined,
  regions: ["f1_hall"],
  path: undefined,
  loop: undefined,
});
assert.deepStrictEqual(spawns[1].at, [1, 2, 3]);
assert.strictEqual(spawns[1].regions, undefined);

// `region:` also takes a list, which mobs.schema.json calls a variant<string, vector<string>> and
// documents as one being picked at random on every spawn. Stringifying that list produced the
// region name "a,b", which exists nowhere, and wrote it back over the real placement.
const pair = patchMobsYaml(mobsYaml, { "17186822": ["f1_hall", "f1_annex"] }, positions);
assert.match(pair, /^ {4}region: {3}\[f1_hall, f1_annex\]$/m, "several regions are written inline");
assert.strictEqual(
  patchMobsYaml(pair, { "17186822": ["f1_hall", "f1_annex"] }, positions),
  pair,
  "patching a list is idempotent too",
);

const paired = parseMobsYaml(pair);
assert.deepStrictEqual(paired[0].regions, ["f1_hall", "f1_annex"], "a list reads back as both names");
assert.deepStrictEqual(
  parseMobsYaml(patchMobsYaml(mobsYaml, { "17186822": ["only_one"] }, positions))[0].regions,
  ["only_one"],
  "one name is still written and read as a plain scalar",
);

// a route is `circuit:` when it closes and `path:` when it is walked out and back
const legs: Vertex[] = [[0, -50, 0], [10, -50, 0], [10, -50, 10]];
const circuit = patchMobsYaml(mobsYaml, {}, positions, { "17186822": { legs } });
assert.match(circuit, /^ {4}circuit:$/m, "a closed route is a circuit");
assert.ok(!circuit.includes("-317.406"), "at: gives way to the route");
assert.deepStrictEqual(parseMobsYaml(circuit)[0].path, legs);
assert.strictEqual(parseMobsYaml(circuit)[0].loop, undefined, "circuit closes, which is the default");
const backAndForth = patchMobsYaml(mobsYaml, {}, positions, { "17186822": { legs, loop: false } });
assert.match(backAndForth, /^ {4}path:$/m, "an out-and-back route is a path");
assert.strictEqual(parseMobsYaml(backAndForth)[0].loop, false);
assert.strictEqual(patchMobsYaml(circuit, {}, positions, { "17186822": { legs } }), circuit, "routes patch idempotently");
assert.strictEqual(patchMobsYaml(circuit, {}, positions), mobsYaml.replace("    region:   stale_region\n", ""), "dropping a route puts at: back");
// A mob the file only ever placed by region has no spot to go back to. Left with neither the
// server cannot spawn it, so it gets a placeholder that is obviously still to be placed.
assert.match(
  patchMobsYaml(assigned, {}, {}),
  /^ {4}at: +\[0\.000, 0\.000, 0\.100\]$/m,
  "unassigning with no known spot leaves a placeholder",
);
assert.doesNotMatch(
  patchMobsYaml("spawns:\n  1:\n    template: Scripted\n    level: [1, 1]\n", {}, {}),
  /at:/,
  "a mob the file never placed is left alone",
);
assert.strictEqual(zoneOfMobId("17186822"), 100); // West Ronfaure

// --- tracing a route out of a trail ---
const lapPoints: TrailPoint[] = [];
const corners = [[0, 0], [60, 0], [60, 60], [0, 60]];
for (let round = 0; round < 3; round++) {
  for (let c = 0; c < 4; c++) {
    const [ax, az] = corners[c];
    const [bx, bz] = corners[(c + 1) % 4];
    for (let t = 0; t < 1; t += 0.1) lapPoints.push({ x: ax + (bx - ax) * t, y: -50, z: az + (bz - az) * t });
  }
}
const traced = routeFromTrail(lapPoints)!;
assert.ok(traced.legs.length >= 4, `a lap of corners keeps them all, got ${traced.legs.length}`);
assert.ok(traced.coverage > 0.95, `the mob never leaves the circuit, got ${traced.coverage}`);
assert.ok(traced.legs.every(v => Math.abs(v[1] + 50) < 0.01), "leg heights come from the samples");
for (const [cx, cz] of corners) {
  assert.ok(traced.legs.some(v => Math.hypot(v[0] - cx, v[2] - cz) < 12), `kept the corner near ${cx},${cz}`);
}

// A beat that passes near its own start partway round: cutting the circuit where the mob comes back
// near the start would drop the spur, and drop it on every lap, so the route would be short by the
// same piece every time. This is the shape that traced 0 legs and then 80% of a real Ronfaure patrol.
const spurred: TrailPoint[] = [];
for (let round = 0; round < 6; round++) {
  for (let t = 0; t < 1; t += 0.05) spurred.push({ x: 100 * t, y: -20, z: 0 }); // out along the beat
  for (let t = 0; t < 1; t += 0.05) spurred.push({ x: 100 - 96 * t, y: -20, z: 4 * t }); // back past the start
  for (let t = 0; t < 1; t += 0.05) spurred.push({ x: 4 - 4 * t, y: -20, z: 4 + 56 * t }); // the spur it also walks
  for (let t = 0; t < 1; t += 0.05) spurred.push({ x: 0, y: -20, z: 60 - 60 * t });
}
const withSpur = routeFromTrail(spurred)!;
assert.ok(withSpur.coverage > 0.9, `the spur belongs to the route, got ${(withSpur.coverage * 100).toFixed(0)}%`);
assert.ok(withSpur.legs.some(v => v[2] > 40), "the far end of the spur is a leg, not a piece left off the route");

// A corridor walked out and back is a route: it is exactly where the mob went, and the legs lie
// along it rather than cutting a shape out of the pair of passes.
const outAndBack: TrailPoint[] = [];
for (let x = 0; x <= 80; x += 4) outAndBack.push({ x, y: -30, z: 0 });
for (let x = 80; x >= 0; x -= 4) outAndBack.push({ x, y: -30, z: 0 });
const corridor = routeFromTrail(outAndBack)!;
assert.ok(corridor.legs.every(v => Math.abs(v[2]) < 1), "the corridor is a straight line, so no leg leaves it");
assert.strictEqual(routeFromTrail([{ x: 0, y: 0, z: 0 }]), null, "not enough samples to trace anything");

// A mob seen in two places with nothing recorded in between: joining them up would draw a leg
// through ground nobody saw it cross, so there is no route to be had.
const teleported: TrailPoint[] = [];
for (let round = 0; round < 6; round++) {
  for (let i = 0; i < 10; i++) teleported.push({ x: i * 4, y: -30, z: 0, t: round * 1000 + i * 4 });
  for (let i = 0; i < 10; i++) teleported.push({ x: 400 + i * 4, y: -30, z: 0, t: round * 1000 + 500 + i * 4 });
}
assert.strictEqual(routeFromTrail(teleported), null, "no leg may cross ground the mob was never seen on");

// jitter around the spawn point is not a route either, however many times it crosses its start
const jitter: TrailPoint[] = [];
for (let i = 0; i < 200; i++) jitter.push({ x: Math.sin(i) * 3, y: -10, z: Math.cos(i * 1.3) * 3 });
assert.strictEqual(routeFromTrail(jitter), null, "never went anywhere, so there is no beat to trace");

assert.deepStrictEqual(
  simplifyLine([[0, 0, 0], [5, 0, 0.1], [10, 0, 0]], 25),
  [[0, 0, 0], [10, 0, 0]],
  "an open line keeps its ends",
);

// --- repairing a shape ---
// A bowtie is two areas wearing one outline, which is what dragging a vertex across an edge makes.
const bowtie: Region = { rings: [[[0, -50, 0], [10, -50, 10], [10, -50, 0], [0, -50, 10]]] };
assert.ok(selfIntersects(bowtie.rings[0]), "the bowtie is the broken case this repairs");
const untied = repairRegion(bowtie);
assert.strictEqual(untied.length, 2, "two areas come back as two regions");
assert.ok(!untied.some(r => selfIntersects(r.rings[0])), "and neither of them crosses itself");
assert.ok(untied.every(r => r.rings[0].every(v => v[1] === -50)), "heights survive, including on the invented corner");

// A shape that is already valid keeps its hole, and its area, rather than being flattened into one ring.
const walled: Region = {
  rings: [[[0, -5, 0], [20, -5, 0], [20, -5, 20], [0, -5, 20]], [[5, -5, 5], [15, -5, 5], [15, -5, 15], [5, -5, 15]]],
};
const repaired = repairRegion(walled);
assert.strictEqual(repaired.length, 1, "one shape in, one shape out");
assert.strictEqual(repaired[0].rings.length, 2, "the hole is still a hole");
assert.ok(Math.abs(regionArea(repaired[0]) - regionArea(walled)) < 0.01, "and it still takes the same area out");
assert.deepStrictEqual(repairRegion({ rings: [[[0, 0, 0], [1, 0, 1]]] }), [], "a line is not a shape");

// What a reshape gave up and took in, as areas: a 20x20 square trimmed to 10x20 gave up half.
const wide: Region = { rings: [[[0, -5, 0], [20, -5, 0], [20, -5, 20], [0, -5, 20]]] };
const narrow: Region = { rings: [[[0, -5, 0], [10, -5, 0], [10, -5, 20], [0, -5, 20]]] };
const givenUp = regionDifference(wide, narrow);
assert.strictEqual(givenUp.length, 1, "one strip given up");
assert.ok(Math.abs(regionArea(givenUp[0]) - 200) < 0.01, "and it is the right half");
assert.ok(givenUp[0].rings[0].every(v => v[1] === -5), "at the region's height");
assert.deepStrictEqual(regionDifference(narrow, wide), [], "nothing was taken in");
// A notch vertex up a wall is dropped and the outline joins straight across. The sliver gained
// is floor, and must stand at the new outline's height, not the notch's.
const notched: Region = { rings: [[[0, -18, 0], [20, -18, 0], [20, -18, 20], [10, -24, 12], [0, -18, 20]]] };
const straight: Region = { rings: [[[0, -18, 0], [20, -18, 0], [20, -18, 20], [0, -18, 20]]] };
const sliver = regionDifference(straight, notched);
assert.strictEqual(sliver.length, 1, "one sliver gained");
assert.ok(sliver[0].rings[0].every(v => v[1] === -18), `at the floor, got ${sliver[0].rings[0].map(v => v[1])}`);

// Visvalingam ranks the tip of an out-and-back as the most disposable point on the line, because the
// triangle there is degenerate. Dropping it collapses the excursion, which is how a patrol traced
// legs that went nowhere near where the mob walks.
const uTurn: Vertex[] = [[0, 0, 0], [20, 0, 0], [40, 0, 0], [60, 0, 0], [40, 0, 1], [20, 0, 1], [0, 0, 1]];
const kept = simplifyLine(uTurn, 4);
assert.ok(kept.some(v => v[0] === 60), "the turn is the whole point of the line, so it survives");

// --- patrol routes ---
const patrolled = patchMobsYaml(mobsYaml, {}, positions, {
  "17186822": { legs: [[1, -50, 2], [3, -50, 4], [5, -50, 6]] },
  "17186823": { legs: [[7, -50, 8], [9, -50, 10]], loop: false },
});
assert.match(
  patrolled,
  /template: Wild_Rabbit\n {4}circuit:\n {6}- \[1\.000, -50\.000, 2\.000\]\n {6}- \[3\.000, -50\.000, 4\.000\]\n {6}- \[5\.000, -50\.000, 6\.000\]\n {4}level: \[1, 1\]\n/,
  "legs replace the fixed spawn point",
);
assert.match(patrolled, /template: Tunnel_Worm\n {4}path:\n/, "an out-and-back route is a path, not a circuit");
assert.ok(!patrolled.includes("-317.406"), "at: removed once a route places it");

const walkers = parseMobsYaml(patrolled);
assert.deepStrictEqual(walkers[0].path, [[1, -50, 2], [3, -50, 4], [5, -50, 6]]);
assert.strictEqual(walkers[0].loop, undefined, "absent loop means it closes");
assert.strictEqual(walkers[0].at, undefined);
assert.strictEqual(walkers[1].loop, false);
assert.strictEqual(
  patchMobsYaml(patrolled, {}, positions, {
    "17186822": { legs: [[1, -50, 2], [3, -50, 4], [5, -50, 6]] },
    "17186823": { legs: [[7, -50, 8], [9, -50, 10]], loop: false },
  }),
  patrolled,
  "patching routes is idempotent",
);
assert.strictEqual(patchMobsYaml(patrolled, {}, positions), mobsYaml.replace("    region:   stale_region\n", ""), "dropping a route restores at:");
assert.strictEqual(
  patchMobsYaml(patrolled, { "17186822": ["f1_hall"] }, positions).match(/^ {4}(path|region):/gm)?.join(","),
  "    region:",
  "a region replaces a route, and only one placement survives",
);

const routeFindings = validate({}, [
  { id: "1", name: "Guard", x: 0, y: 0, z: 0, path: [[0, 0, 0]] },
  { id: "2", name: "Patrol", x: 0, y: 0, z: 0, path: [[0, 0, 0], [1, 0, 1]], regions: ["somewhere"] },
], { "2": ["somewhere"] });
assert.ok(routeFindings.some(f => f.text.includes("patrol route with 1 legs")), "a one-leg route is not a route");
assert.ok(routeFindings.some(f => f.text.includes("both a region and a patrol route")), "two placements at once");

// --- diffing two versions of a zone ---
const before: ZoneSide = {
  regions: {
    kept: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    grown: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    gone: { rings: [[[50, -50, 50], [60, -50, 50], [60, -50, 60], [50, -50, 60]]] },
  },
  spawns: [
    { id: "1", name: "Rabbit", x: 1, y: -50, z: 1, regions: ["kept"] },
    { id: "2", name: "Bat", x: 2, y: -50, z: 2, regions: ["gone"] },
    { id: "3", name: "Worm", x: 3, y: -50, z: 3, at: [3, -50, 3] },
  ],
};
const after: ZoneSide = {
  regions: {
    kept: { rings: [[[0, -50, 0], [10, -50, 0], [10, -50, 10], [0, -50, 10]]] },
    grown: { rings: [[[0, -50, 0], [20, -50, 0], [20, -50, 10], [0, -50, 10]]] },
    fresh: { rings: [[[70, -50, 70], [80, -50, 70], [80, -50, 80]]] },
  },
  spawns: [
    { id: "1", name: "Rabbit", x: 1, y: -50, z: 1, regions: ["kept"] },
    { id: "2", name: "Bat", x: 2, y: -50, z: 2, regions: ["grown"] },
    { id: "3", name: "Worm", x: 3, y: -50, z: 3, regions: ["fresh"] },
  ],
};
const delta = diffRegions(before, after);
assert.deepStrictEqual(delta.added, ["fresh"]);
assert.deepStrictEqual(delta.removed, ["gone"]);
assert.deepStrictEqual(delta.unchanged, ["kept"]);
assert.deepStrictEqual(delta.reshaped, [
  { name: "grown", fromVertices: 4, toVertices: 4, areaRatio: 2, fromHoles: 0, toHoles: 0 },
]);

// A region can change by nothing but its holes: the outline identical to the vertex, a piece cut
// out of the middle. Reporting only the outline calls that no change, on the one row whose job is
// to say what changed.
const holed = diffRegions(
  { regions: { pit: { rings: [[[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]] } }, spawns: [] },
  {
    regions: {
      pit: {
        rings: [
          [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]],
          [[4, 0, 4], [6, 0, 4], [6, 0, 6], [4, 0, 6]],
        ],
      },
    },
    spawns: [],
  },
);
assert.strictEqual(holed.reshaped.length, 1, "a hole is a change");
assert.strictEqual(holed.reshaped[0].fromVertices, holed.reshaped[0].toVertices, "and the outline is untouched");

// The title says what was done; the names are underneath, where a reviewer can find them.
const message = commitMessage("west_ronfaure", before, after);
assert.strictEqual(message.split("\n")[0], "west_ronfaure: +1 -1 ~1 regions, 2 spawns placed");
assert.ok(
  message.includes("\n\nAdded: fresh\nRemoved: gone\nReshaped grown (area +100%)\nPlaced in grown: Bat 2 (was gone)\nPlaced in fresh: Worm 3"),
  message,
);
assert.strictEqual(commitMessage("z", before, before), "z: regions updated", "nothing to say still gets a title");
const walked = { ...before, spawns: before.spawns.map(s => (s.id === "3" ? { ...s, path: [[0, 0, 0], [5, 0, 5]] as Vertex[] } : s)) };
assert.strictEqual(commitMessage("z", before, walked), "z: 1 patrol changed\n\nPatrols: Worm 3", "a route is a change too");
assert.deepStrictEqual(
  [holed.reshaped[0].fromHoles, holed.reshaped[0].toHoles],
  [0, 1],
  "so the holes are the only thing that can explain it",
);
assert.deepStrictEqual(delta.moved, [
  { id: "2", name: "Bat", from: "gone", to: "grown" },
  { id: "3", name: "Worm", from: undefined, to: "fresh" },
]);
assert.deepStrictEqual([delta.addedSpawns, delta.removedSpawns], [[], []]);
assert.deepStrictEqual(diffRegions(after, after).reshaped, [], "a side against itself has no changes");
assert.strictEqual(regionArea(before.regions.kept), 100);
assert.strictEqual(regionArea(regions.f1_hall), 96, "holes come out of the area");

// --- review ---
const findings = validate(
  { ...regions, empty_room: { rings: [[[0, 0, 0], [1, 0, 0]]] } },
  [
    { id: "1", name: "Rabbit", x: 1, y: -49, z: 1, at: [1, -49, 1] },
    { id: "2", name: "Bat", x: 1, y: -69, z: 1, at: [1, -69, 1] },
    { id: "3", name: "Worm", x: 99, y: -50, z: 99, at: [99, -50, 99] },
    { id: "4", name: "Crab", x: 1, y: -50, z: 1, at: [1, -50, 1] },
    { id: "5", name: "Hare", x: 2, y: -50, z: 2, at: [2, -50, 2] },
    { id: "6", name: "Ghost", x: 0, y: 0, z: 0 },
  ],
  { "1": ["f1_hall"], "2": ["f1_hall"], "3": ["f1_hall"], "4": ["ghost_region"] },
);
const has = (t: string) => findings.some(f => f.text.includes(t));
assert.ok(has("only 2 vertices"), "degenerate ring");
assert.ok(has("no spawns assigned"), "unused region");
assert.ok(has("nearer f2_hall's floor"), "wrong floor");
assert.ok(has("stands outside"), "assigned but outside");
assert.ok(has("undefined region ghost_region"), "dangling reference");
assert.ok(has("2 spawns on a fixed point"), "tally of the ones no region or route places");
assert.ok(has("1 spawns have no position, region or route"), "spawn left with nowhere to go");

// A mob that names several regions is in whichever one the server picks, so it counts towards
// each of them and only stands "outside" when it is outside all of them.
const shared = validate(
  regions,
  [
    { id: "1", name: "Rabbit", x: 1, y: -49, z: 1, at: [1, -49, 1] },
    { id: "2", name: "Bat", x: 99, y: -50, z: 99, at: [99, -50, 99] },
  ],
  { "1": ["f1_hall", "f2_hall"], "2": ["f1_hall", "f2_hall"] },
);
assert.ok(
  !shared.some(f => f.text.includes("no spawns assigned")),
  "both regions count the mob that names them, so neither reads as unused",
);
assert.ok(
  !shared.some(f => f.spawnId === "1" && f.text.includes("stands outside")),
  "inside one of them is not outside",
);
assert.ok(
  shared.some(f => f.spawnId === "2" && f.text.includes("stands outside f1_hall, f2_hall")),
  "outside all of them names all of them",
);

/** Two regions are the same shape when the canonical emitter cannot tell them apart. */
const sameShape = (a: Region, b: Region) => emitRegionsBlock({ x: a }) === emitRegionsBlock({ x: b });

// --- reading a zone back out of text somebody kept ---

// What Copy YAML writes: both files, each under its own header.
const copied = `# --- regions.yaml ---
${patchRegionsYaml("", regions)}
# --- mobs.yaml (spawns section) ---
${assigned}`;
let back = parsePastedZone(copied);
assert.deepStrictEqual(Object.keys(back.regions).sort(), ["f1_hall", "f2_hall"], "both regions came back");
assert.strictEqual(back.spawns?.length, 2, "and the spawns with them");
assert.strictEqual(back.spawns?.find(s => s.id === "17186822")?.regions?.[0], "f1_hall", "including where each is placed");

// A regions.yaml on its own, with no header at all.
back = parsePastedZone(patchRegionsYaml("", regions));
assert.deepStrictEqual(Object.keys(back.regions).sort(), ["f1_hall", "f2_hall"]);
assert.strictEqual(back.spawns, undefined, "nothing was said about placement, so nothing is claimed");

// A mobs.yaml on its own is recognised by what is in it rather than by a name.
back = parsePastedZone(assigned);
assert.deepStrictEqual(back.regions, {}, "it carries no geometry");
assert.strictEqual(back.spawns?.length, 2);

// An older copy, from when regions lived in zone.yaml.
back = parsePastedZone(`# --- zone.yaml ---\n${patchRegionsYaml("", regions)}`);
assert.deepStrictEqual(Object.keys(back.regions).sort(), ["f1_hall", "f2_hall"], "zone.yaml is still where some copies keep them");

// Nothing worth reading is not a crash.
assert.deepStrictEqual(parsePastedZone(""), { regions: {} });
assert.deepStrictEqual(parsePastedZone("# --- regions.yaml ---\n"), { regions: {}, spawns: undefined });

// --- merging two people's work on one zone ---

const box = (x: number): Region => ({ rings: [[[x, -50, 0], [x + 5, -50, 0], [x + 5, -50, 5], [x, -50, 5]]] });
const state = (regions: RegionSet, placements = {}): ZoneState => ({ regions, placements });

// The ordinary case: two people in the same zone, nowhere near each other. Nobody should be asked
// anything, and neither should lose work.
let merged = mergeZone(
  state({ shared: box(0) }),
  state({ shared: box(0), theirs: box(50) }),
  state({ shared: box(0), ours: box(100) }),
);
assert.deepStrictEqual(merged.conflicts, [], "separate regions are not a disagreement");
assert.deepStrictEqual(Object.keys(merged.regions).sort(), ["ours", "shared", "theirs"], "and both survive");

// One side moved a region the other never touched: the one who moved it wins, silently.
merged = mergeZone(state({ a: box(0) }), state({ a: box(9) }), state({ a: box(0) }));
assert.ok(sameShape(merged.regions.a, box(9)), "their edit stands where we made none");
merged = mergeZone(state({ a: box(0) }), state({ a: box(0) }), state({ a: box(9) }));
assert.ok(sameShape(merged.regions.a, box(9)), "and ours where they made none");

// Both moved it, differently. That is a real disagreement and has to be named.
merged = mergeZone(state({ a: box(0) }), state({ a: box(9) }), state({ a: box(20) }));
assert.deepStrictEqual(merged.conflicts, ["region a"], "named, not counted");

// A region one side deleted and the other left alone goes.
merged = mergeZone(state({ a: box(0), b: box(9) }), state({ a: box(0) }), state({ a: box(0), b: box(9) }));
assert.deepStrictEqual(Object.keys(merged.regions), ["a"], "their deletion stands");

// Placement: two people assigning different mobs is not a disagreement.
merged = mergeZone(
  state({}, { "1": {}, "2": {} }),
  state({}, { "1": { regions: ["north"] }, "2": {} }),
  state({}, { "1": {}, "2": { regions: ["south"] } }),
);
assert.deepStrictEqual(merged.conflicts, []);
assert.deepStrictEqual(merged.placements, { "1": { regions: ["north"] }, "2": { regions: ["south"] } }, "both assignments kept");

// The same mob sent to two different regions is.
merged = mergeZone(
  state({}, { "1": {} }),
  state({}, { "1": { regions: ["north"] } }),
  state({}, { "1": { regions: ["south"] } }),
);
assert.deepStrictEqual(merged.conflicts, ["spawn 1"]);
assert.deepStrictEqual(merged.placements["1"], { regions: ["south"] }, "ours is kept so the editor still shows what it had");

// Both doing the same thing is agreement, not conflict.
merged = mergeZone(state({ a: box(0) }), state({ a: box(9) }), state({ a: box(9) }));
assert.deepStrictEqual(merged.conflicts, []);

// placementsOf reads all three ways a spawn can be placed
const placed = placementsOf([
  { id: "1", name: "a", x: 0, y: 0, z: 0, regions: ["north"] },
  { id: "2", name: "b", x: 0, y: 0, z: 0, path: [[0, 0, 0], [1, 0, 1]], loop: false },
  { id: "3", name: "c", x: 1, y: 2, z: 3, at: [1, 2, 3] },
]);
assert.deepStrictEqual(placed["1"], { regions: ["north"] });
assert.deepStrictEqual(placed["2"], { patrol: { legs: [[0, 0, 0], [1, 0, 1]], loop: false } });
assert.deepStrictEqual(placed["3"], {}, "a fixed point is the absence of a placement, not a placement");

// The editor's maps say the same thing placementsOf reads off the file, so a zone nobody touched
// merges as untouched. Spelling the field "region" once made every assigned spawn look edited,
// and the merge then dropped their regions whenever base had moved.
const spawnsHere = [
  { id: "1", name: "a", x: 0, y: 0, z: 0, regions: ["north"] },
  { id: "2", name: "b", x: 0, y: 0, z: 0, path: [[0, 0, 0], [1, 0, 1]] as Vertex[], loop: false },
  { id: "3", name: "c", x: 1, y: 2, z: 3, at: [1, 2, 3] as Vertex },
];
const { assign: heldAssign, paths: heldPaths } = splitPlacements(placementsOf(spawnsHere));
assert.deepStrictEqual(heldAssign, { "1": ["north"] });
assert.deepStrictEqual(Object.keys(heldPaths), ["2"]);
assert.deepStrictEqual(placementsFrom(spawnsHere, heldAssign, heldPaths), placementsOf(spawnsHere), "round trip");
merged = mergeZone(
  state({}, placementsOf(spawnsHere)),
  state({}, { ...placementsOf(spawnsHere), "3": { regions: ["south"] } }),
  state({}, placementsFrom(spawnsHere, heldAssign, heldPaths)),
);
assert.deepStrictEqual(merged.conflicts, []);
assert.deepStrictEqual(splitPlacements(merged.placements).assign, { "1": ["north"], "3": ["south"] }, "ours untouched, theirs taken");

console.log("ok");
