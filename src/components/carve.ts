// Carving holes in the selected region: the obstacles the collision mesh shows, the empty patches the
// roam data leaves, growing a hole over unvisited ground and merging holes that touch. Made by the
// region editor with what it reads and writes passed in, so what this depends on is all here.
import { type Accessor, createMemo, createSignal, type Setter } from "solid-js";
import * as THREE from "three";
import { convexHull, inRing, mostlyInside, nearestHeight, ringDistance, signedArea, withinRing } from "../geometry";
import type { FloorIndex } from "../graphics/floors";
import {
  cellKey,
  cellOf,
  cellsInside,
  elongation,
  emptyPatches,
  findObstacles,
  floodPatch,
  groundNear,
  keyOfCell,
  obstacleArea,
  ringsAround,
  traceCells,
} from "../obstacles";
import type { Obstacle } from "../obstacles";
import { repairRegion } from "../regions";
import type { Region, Ring, TrailPoint, Vertex } from "../regions";
import { putOnGround } from "../terrain";
import type { DialSpec } from "./dial";

/** Grid the collision mesh's steep faces are read on, in yalms. */
export const OBSTACLE_CELL = 0.5;

/** Where every carving dial starts, and where Defaults puts it back. Distances in yalms. */
export const OBSTACLE_DEFAULTS = {
  margin: 1,
  slope: 50,
  join: 1,
  climb: 2,
  minHeight: 0.5,
  minArea: 0.5,
  bulkMax: 150,
  clearance: 1,
  reach: 2,
  gapMinArea: 6,
};

/** A grow plan: the spot a hole is grown from. */
export interface GrowPlan {
  name: string;
  x: number;
  z: number;
  y: number;
}
/** A merge plan: the hole the others within reach are merged into. */
export interface MergePlan {
  name: string;
  index: number;
}

export interface RegionEntry extends Region {
  name: string;
}

export interface CarveContext {
  regions: Accessor<RegionEntry[]>;
  setRegions: Setter<RegionEntry[]>;
  /** The regions as they were once the mouse stopped, which the scans read. */
  settled: Accessor<RegionEntry[]>;
  setSettled: Setter<RegionEntry[]>;
  activeName: Accessor<string | null>;
  mode: () => "select" | "draw" | "obstacles";
  floor: Accessor<number | null>;
  zoneMesh: () => THREE.Mesh | undefined;
  floorIndex: () => FloorIndex | undefined;
  /** The roam trail of every mob a region places. */
  trailOf: (name: string) => TrailPoint[];
  hasRoam: () => boolean;
  grow: () => GrowPlan | null;
  setGrow: (plan: GrowPlan | null) => void;
  merge: () => MergePlan | null;
  setMerge: (plan: MergePlan | null) => void;
  checkpoint: (label: string) => void;
  flash: (text: string, tone?: "ok" | "warn") => void;
  setHoleHover: (hover: null) => void;
}

export function createCarve(ctx: CarveContext) {
  const { regions, setRegions, settled, setSettled, activeName, mode, floor, grow, setGrow, merge, setMerge, checkpoint, flash, setHoleHover } = ctx;

  /** Holes of the active region within `reach` yalms of hole `index`, itself excluded. */
  const nearHoles = (r: Region, index: number, reach = 2) =>
    r.rings.map((ring, k) => k).filter(k => k >= 1 && k !== index && r.rings[k].length >= 3 && ringDistance(r.rings[index], r.rings[k]) <= reach);
  /** lastYOf for the many spots of one scan, from a spatial index of the region's corners. */
  const heightsNear = (r: Region) => nearestHeight(r.rings.flat());

  /**
   * Growing a hole from the roam data: the ground around a spot that no member mob was recorded
   * within `clearance` of, as one connected patch, becomes the hole (joined with whatever hole is
   * already there). It is the data's own answer to "how big is this obstacle": the samples stop
   * where the mobs stopped. Two steps, like a merge: a plan with a dial, then Apply.
   */
  const [growClearance, setGrowClearance] = createSignal(OBSTACLE_DEFAULTS.clearance);
  const growPlan = createMemo(() => {
    const g = grow();
    const entry = g && regions().find(r => r.name === g.name);
    if (!g || !entry || (entry.rings[0]?.length ?? 0) < 3) return null;
    const cell = OBSTACLE_CELL;
    // Every cell within the clearance of a sample is ground the mobs use. From the spot, the rest
    // inside the outline; a patch over a quarter of the region is the outline being wrong.
    const near = groundNear(walkedCellsAll(), growClearance(), cell);
    const outline = entry.rings[0];
    const start = cellKey(g.x, g.z, cell);
    if (near.has(start)) return { entry, cells: new Map<number, number>(), ring: null, why: "mobs were recorded right here" };
    const patch = floodPatch(start, near, outline, cell, Math.abs(signedArea(outline)) * 0.25 / (cell * cell));
    const taken = new Map([...patch.cells].map(k => [k, g.y]));
    if (patch.overBudget) return { entry, cells: taken, ring: null, why: "would take over a quarter of the region" };
    const rings = traceCells(taken, cell, g.y).sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const ring = rings[0] ? onGround(rings[0].map(([x, , z]) => [x, sampleFloor(x, z, g.y), z] as Vertex)) : null;
    return { entry, cells: taken, ring, why: rings[0] ? null : "nothing to grow into" };
  });
  const growHole = () => {
    const plan = growPlan();
    const g = grow();
    if (!plan || !g || !plan.ring) return flash(plan?.why ?? "nothing to grow", "warn");
    const one = asOne(repairRegion({ rings: [...plan.entry.rings, plan.ring] }), Math.abs(signedArea(plan.entry.rings[0])));
    if (!one) return flash(`growing here would cut ${g.name} in two`, "warn");
    checkpoint("grow a hole from the roam data");
    setRegions(rs => rs.map(r => (r.name === g.name ? { name: g.name, rings: one.rings.map(onGround) } : r)));
    setHoleHover(null);
    setGrow(null);
    flash(`hole grown to ${(plan.cells.size * OBSTACLE_CELL * OBSTACLE_CELL).toFixed(0)} y² of unvisited ground`);
  };

  /**
   * Merging is two steps: the menu opens a plan with a reach dial and a preview of the hull, and
   * Apply commits it. The merged hole is the convex hull of the group's vertices, since two
   * obstacles a mob cannot pass between are one obstacle to it. Undo brings the pieces back.
   */
  const [mergeReach, setMergeReach] = createSignal(OBSTACLE_DEFAULTS.reach);
  const mergePlan = createMemo(() => {
    const m = merge();
    const entry = m && regions().find(r => r.name === m.name);
    if (!m || !entry || !entry.rings[m.index]) return null;
    const group = [m.index, ...nearHoles(entry, m.index, mergeReach())];
    return { entry, group, hull: group.length > 1 ? onGround(convexHull(group.flatMap(k => entry.rings[k]))) : null };
  });
  const mergeHoles = () => {
    const plan = mergePlan();
    const m = merge();
    if (!plan || !m || !plan.hull) return flash("no other hole within reach", "warn");
    const { entry, group, hull } = plan;
    const rings = [...entry.rings.filter((_, k) => !group.includes(k)), hull];
    const one = asOne(repairRegion({ rings }), Math.abs(signedArea(entry.rings[0])));
    if (!one) return flash(`merging these would cut ${m.name} in two`, "warn");
    checkpoint(`merge ${group.length} holes`);
    setRegions(rs => rs.map(r => (r.name === m.name ? { name: m.name, rings: one.rings.map(onGround) } : r)));
    setHoleHover(null);
    setMerge(null);
    flash(`merged ${group.length} holes`);
  };

  // --- obstacles: holes drawn around the collision mesh's steep faces ---
  // The dials: how far off the faces the ring sits, what counts as steep, how close faces must be
  // to be one obstacle, how tall and how wide an obstacle must be to show at all, and how big one
  // may be before "ring all" skips it.
  const TALL_FACE = 2; // yalms of face height in one cell: a trunk or a rock wall, not a bank or a root
  // How far above and below the walked ground a steep face may lie and still stand on this storey.
  const STOREY_ABOVE = 3;
  const STOREY_BELOW = 2;
  const [obstacleMargin, setObstacleMargin] = createSignal(OBSTACLE_DEFAULTS.margin); // yalms
  const [obstacleSlope, setObstacleSlope] = createSignal(OBSTACLE_DEFAULTS.slope); // degrees from level
  const [obstacleJoin, setObstacleJoin] = createSignal(OBSTACLE_DEFAULTS.join); // yalms
  const [obstacleClimb, setObstacleClimb] = createSignal(OBSTACLE_DEFAULTS.climb); // yalms above the foot
  const [obstacleMinHeight, setObstacleMinHeight] = createSignal(OBSTACLE_DEFAULTS.minHeight); // yalms
  const [obstacleMinArea, setObstacleMinArea] = createSignal(OBSTACLE_DEFAULTS.minArea); // square yalms of footprint
  const [obstacleBulkMax, setObstacleBulkMax] = createSignal(OBSTACLE_DEFAULTS.bulkMax); // square yalms of footprint
  const DIALS: DialSpec[] = [
    {
      label: "margin",
      unit: "y",
      get: obstacleMargin,
      set: setObstacleMargin,
      min: 0,
      max: 5,
      step: 0.25,
      title: "How far off the faces the hole ring sits: the mob's own radius plus some",
    },
    {
      label: "steeper than",
      unit: "°",
      get: obstacleSlope,
      set: setObstacleSlope,
      min: 20,
      max: 85,
      step: 1,
      title: "A face this steep or more is an obstacle; below it is ground a mob walks",
    },
    {
      label: "join within",
      advanced: true,
      unit: "y",
      get: obstacleJoin,
      set: setObstacleJoin,
      min: 0,
      max: 4,
      step: 0.25,
      title: "Faces this close are one obstacle: a trunk and its branches, a rock and its ledges",
    },
    {
      label: "climb",
      advanced: true,
      unit: "y",
      get: obstacleClimb,
      set: setObstacleClimb,
      min: 0,
      max: 8,
      step: 0.5,
      title:
        "Ground the steep faces lead up onto, this far above their foot, is part of the obstacle: a rock's top, the plateau behind a cliff. 0 keeps only the faces",
    },
    {
      label: "at least tall",
      advanced: true,
      unit: "y",
      get: obstacleMinHeight,
      set: setObstacleMinHeight,
      min: 0,
      max: 4,
      step: 0.25,
      title: "Lower than this is a kerb or a root, not something a mob paths around",
    },
    {
      label: "at least wide",
      advanced: true,
      unit: "y²",
      get: obstacleMinArea,
      set: setObstacleMinArea,
      min: 0,
      max: 10,
      step: 0.25,
      title: "Footprint under this is a speck of geometry",
    },
    {
      label: "ring all up to",
      unit: "y²",
      get: obstacleBulkMax,
      set: setObstacleBulkMax,
      min: 5,
      max: 500,
      step: 5,
      title: "Ring all skips anything bigger: a cliff or a wall takes a click of its own",
    },
  ];
  const resetObstacleDials = () => {
    setObstacleMargin(OBSTACLE_DEFAULTS.margin);
    setObstacleSlope(OBSTACLE_DEFAULTS.slope);
    setObstacleJoin(OBSTACLE_DEFAULTS.join);
    setObstacleClimb(OBSTACLE_DEFAULTS.climb);
    setObstacleMinHeight(OBSTACLE_DEFAULTS.minHeight);
    setObstacleMinArea(OBSTACLE_DEFAULTS.minArea);
    setObstacleBulkMax(OBSTACLE_DEFAULTS.bulkMax);
    setGrowClearance(OBSTACLE_DEFAULTS.clearance);
    setMergeReach(OBSTACLE_DEFAULTS.reach);
    setGapMinArea(OBSTACLE_DEFAULTS.gapMinArea);
  };
  // The obstacle under the cursor in carve mode: its ring lights up, and a click cuts it.
  const [obstacleHover, setObstacleHover] = createSignal<{ obstacle: Obstacle; x: number; y: number; } | null>(null);
  /** A cliff line or a wall: long and thin, and big enough for "thin" to mean anything. Ring
   * all leaves those to a deliberate click. */
  const isCliff = (o: Obstacle) => obstacleArea(o, OBSTACLE_CELL) >= 10 && elongation(o, OBSTACLE_CELL) > 2.5;
  const bulk = () => obstacles().filter(o => obstacleArea(o, OBSTACLE_CELL) <= obstacleBulkMax() && !isCliff(o));
  const memberTrailAll = createMemo(() => {
    const name = activeName();
    if (!name) return [] as TrailPoint[];
    return ctx.trailOf(name);
  });
  /** The cells the active region's own mobs were recorded in: a ring never takes those, since the
   * data has a mob standing there whatever the mesh says. */
  const walkedCellsAll = createMemo(() => {
    const out = new Set<number>();
    for (const p of memberTrailAll()) out.add(cellKey(p.x, p.z, OBSTACLE_CELL));
    return out;
  });
  const walkedCells = createMemo(() => (mode() === "obstacles" ? walkedCellsAll() : new Set<number>()));
  /** Mean sample height by 4-yalm bucket, so a ring drawn from the roam data can start at the
   * height the mobs were actually recorded at next to it, then be dropped onto the terrain. */
  const sampleHeights = createMemo(() => {
    const out = new Map<number, [number, number]>();
    for (const p of memberTrailAll()) {
      const k = cellKey(p.x, p.z, 4);
      const acc = out.get(k);
      if (acc) (acc[0] += p.y, acc[1]++);
      else out.set(k, [p.y, 1]);
    }
    return out;
  });
  const sampleFloor = (x: number, z: number, fallback: number) => {
    const buckets = sampleHeights();
    const [ix, iz] = cellOf(cellKey(x, z, 4));
    for (let radius = 0; radius <= 3; radius++) {
      let sum = 0, n = 0;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const acc = buckets.get(keyOfCell(ix + dx, iz + dz));
          if (acc) (sum += acc[0], n += acc[1]);
        }
      }
      if (n) return sum / n;
    }
    return fallback;
  };
  // Scans read the region as it was once the mouse stopped: a vertex drag is not worth a pass over
  // every triangle in the zone on each mouse move. The picture still follows the drag live.
  const settledActive = () => settled().find(r => r.name === activeName());
  /**
   * The steep faces inside the selected region's outline on the current floor, clustered into
   * obstacles, before any size or margin filter. This is the expensive half, over every triangle
   * in the zone, so it reruns only when something it reads changes: not on the margin or size
   * dials, which only filter what it found.
   */
  const rawObstacles = createMemo<Obstacle[]>(() => {
    if (mode() !== "obstacles") return [];
    const r = settledActive();
    const mesh = ctx.zoneMesh(), fi = ctx.floorIndex();
    if (!r || !mesh || !fi || (r.rings[0]?.length ?? 0) < 3) return [];
    const pos = mesh.geometry.getAttribute("position").array as Float32Array;
    const only = floor();
    const up = Math.cos((obstacleSlope() * Math.PI) / 180);
    const perVertex = fi.perVertex;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, , z] of r.rings[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const heightAt = heightsNear(r);
    // By the cell a face falls in, which is the grid the obstacles are built on anyway.
    const insideCell = cellsInside(r.rings[0], OBSTACLE_CELL);
    const keep = (t: number) => {
      if (only !== null && perVertex[t * 3] !== only) return false;
      const o = t * 9;
      const x = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
      const z = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
      // Inside the outline, holes included: an obstacle half inside an old hole is still one
      // obstacle, and its ring is what grows that hole to fit it.
      if (x < minX || x > maxX || z < minZ || z > maxZ || !insideCell(Math.floor(x / OBSTACLE_CELL), Math.floor(z / OBSTACLE_CELL))) return false;
      // And on this storey: a face that never comes near the ground the mobs walk on here is a
      // wall of the floor above or below, which in a zone of storeys lies under the same outline
      // and was ringed as a 25-yalm "cliff" across open floor. y points down, so above is less.
      const ground = sampleFloor(x, z, heightAt(x, z));
      const top = Math.min(pos[o + 1], pos[o + 4], pos[o + 7]);
      const bottom = Math.max(pos[o + 1], pos[o + 4], pos[o + 7]);
      return top <= ground + STOREY_BELOW && bottom >= ground - STOREY_ABOVE - obstacleClimb();
    };
    const scan = { cell: OBSTACLE_CELL, up, join: obstacleJoin(), climb: obstacleClimb(), avoid: walkedCells(), keep };
    const found = findObstacles(pos, scan);
    // A blob past the bulk size, or shaped like a cliff, is trees and rocks chained together
    // through the low faces between them: roots, a bank. Its tall faces, the trunks and rock
    // walls, are found again on their own and offered as parts.
    const blobs = found.filter(o => obstacleArea(o, OBSTACLE_CELL) > obstacleBulkMax() || isCliff(o));
    if (blobs.length) {
      const inBlob = new Set(blobs.flatMap(o => o.cells.map(([ix, iz]) => keyOfCell(ix, iz))));
      // A blob made of nothing but tall faces comes back as its own part; offering it twice
      // counted one obstacle as two.
      const cellsOf = (o: Obstacle) => o.cells.map(([ix, iz]) => keyOfCell(ix, iz)).sort((a, b) => a - b).join();
      const listed = new Set(found.map(cellsOf));
      for (const part of findObstacles(pos, { ...scan, minSpan: TALL_FACE })) {
        if (listed.has(cellsOf(part))) continue;
        if (part.cells.filter(([ix, iz]) => inBlob.has(keyOfCell(ix, iz))).length * 2 >= part.cells.length) found.push(part);
      }
    }
    return found;
  });
  /** What is left to cut once the dials that only filter have had their say. */
  const obstacles = createMemo<Obstacle[]>(() => {
    const r = settledActive();
    const found = rawObstacles();
    if (!r || !found.length) return [];
    const minHeight = obstacleMinHeight();
    const minArea = obstacleMinArea();
    const holes = r.rings.slice(1).filter(h => h.length >= 3);
    // Nothing left to cut: a ring already inside an old hole, or one mostly outside the outline,
    // which is the wall the region ends at and would only carve a yalm off the border.
    const spent = (o: Obstacle) => {
      const ring = ringsAround([o], obstacleMargin(), OBSTACLE_CELL, walkedCells())[0];
      if (!ring) return true;
      if (holes.some(h => ring.every(([x, , z]) => withinRing(h, x, z, OBSTACLE_CELL / 2)))) return true;
      return ring.filter(([x, , z]) => inRing(r.rings[0], x, z)).length < 0.3 * ring.length;
    };
    // Height is foot minus top because y points down.
    return found.filter(o => o.foot - o.top >= minHeight && obstacleArea(o, OBSTACLE_CELL) >= minArea && !spent(o));
  });
  /**
   * Terrain height under a ring vertex, found by dropping a ray through the zone mesh near the
   * obstacle's own foot. A ring around a rock on a slope needs each vertex on the ground beside
   * it, not all at one height, or it floats on the downhill side and buries on the uphill one.
   */
  const onGround = (ring: Ring): Ring => {
    const mesh = ctx.zoneMesh();
    if (!mesh) return ring;
    const ray = new THREE.Raycaster();
    const grounded = ring.map(([x, y, z]) => {
      // The scene is mirrored (see graphics/scene.ts), so the ray is set up in world space from
      // two zone points: from 30 yalms above the vertex straight down through it.
      const from = mesh.localToWorld(new THREE.Vector3(x, y - 30, z));
      const to = mesh.localToWorld(new THREE.Vector3(x, y + 30, z));
      ray.set(from, to.clone().sub(from).normalize());
      ray.far = from.distanceTo(to);
      const hits = ray.intersectObject(mesh, false);
      // The surface nearest the reference height. A bridge overhead or a cave below loses to the
      // one the reference is near; with none within a step of it the reference was wrong (samples
      // on a rock beside the spot) and the nearest surface there is still the ground.
      let best = y;
      let gap = Infinity;
      for (const h of hits) {
        const p = mesh.worldToLocal(h.point.clone());
        if (Math.abs(p.y - y) < gap) (gap = Math.abs(p.y - y), best = p.y);
      }
      return [x, best, z] as Vertex;
    });
    // A vertex that landed on a floor its neighbours along the ring did not (the top of the rock
    // the ring goes round) comes back to their height. Neighbours, not the whole ring: a ring up
    // a hillside spans far more than a step from end to end and is still on the ground.
    const n = grounded.length;
    return grounded.map(([x, y, z], i) => {
      if (n < 3) return [x, y, z] as Vertex;
      const beside = (grounded[(i + 1) % n][1] + grounded[(i - 1 + n) % n][1]) / 2;
      return [x, Math.abs(y - beside) > 6 ? beside : y, z] as Vertex;
    });
  };
  /** Every surface height under a zone point, by ray through the zone mesh. */
  const surfacesUnder = (x: number, y: number, z: number): number[] => {
    const mesh = ctx.zoneMesh();
    if (!mesh) return [];
    const ray = new THREE.Raycaster();
    const from = mesh.localToWorld(new THREE.Vector3(x, y - 60, z));
    const to = mesh.localToWorld(new THREE.Vector3(x, y + 60, z));
    ray.set(from, to.clone().sub(from).normalize());
    ray.far = from.distanceTo(to);
    return ray.intersectObject(mesh, false).map(h => mesh.worldToLocal(h.point.clone()).y);
  };
  const groundRing = (ring: Ring): [Ring, number] => (ctx.zoneMesh() ? putOnGround(ring, surfacesUnder) : [ring, 0]);
  /**
   * The clipper's answer as one region, or null when the cut genuinely splits it. Two rings that
   * overlap at two points fence off a pocket of ground between them; that pocket comes back as a
   * piece of its own, and since nothing reaches it, it is absorbed rather than counted as a split.
   * A piece with real area, or with a mob recorded in it, is a split.
   */
  const asOne = (pieces: Region[], outlineArea: number): Region | null => {
    if (pieces.length === 1) return pieces[0];
    if (!pieces.length) return null;
    const sized = pieces.map(p => ({ p, area: Math.abs(signedArea(p.rings[0])) })).sort((a, b) => b.area - a.area);
    // Every member's trail, whatever the mode: grow and merge are reached from the hole menu
    // outside carve mode, and a pocket with a mob in it is a split there too.
    const trail = memberTrailAll();
    for (const { p, area } of sized.slice(1)) {
      if (area >= 0.05 * outlineArea) return null;
      if (trail.some(t => inRing(p.rings[0], t.x, t.z))) return null;
    }
    return sized[0].p;
  };
  /** The rings the obstacles on offer would cut, merged where their margins meet: what Ring all
   * takes, and separately what is over its size and waits for a click. */
  const previewRings = createMemo(() => ({
    bulk: ringsAround(bulk(), obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround),
    big: ringsAround(obstacles().filter(o => !bulk().includes(o)), obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround),
  }));
  /**
   * Roam gaps: ground inside the region, enclosed by ground the mobs use, that no member mob was
   * recorded within the clearance of. The mesh has nothing there (a bush, a fence with no
   * collision, a spot they simply never stand on), but the data does: a ring of samples around an
   * empty disc. Found alongside the obstacles in carve mode and cut the same way.
   */
  const [gapMinArea, setGapMinArea] = createSignal(OBSTACLE_DEFAULTS.gapMinArea); // square yalms
  const rawGaps = createMemo<Ring[]>(() => {
    // Settled, like the obstacle scan: this is a flood fill over the whole region, not something to
    // redo for every move of a dragged corner.
    const r = settledActive();
    if (mode() !== "obstacles" || !r || (r.rings[0]?.length ?? 0) < 3 || !walkedCells().size) return [];
    const cell = OBSTACLE_CELL;
    const outline = r.rings[0];
    const near = groundNear(walkedCells(), growClearance(), cell);
    const patches = emptyPatches(outline, near, cell, gapMinArea() / (cell * cell), Math.abs(signedArea(outline)) * 0.25 / (cell * cell));
    // A patch that already lies inside a hole has nothing left to cut.
    const holes = r.rings.slice(1).filter(h => h.length >= 3);
    const out: Ring[] = [];
    const heightAt = heightsNear(r);
    for (const cells of patches) {
      const [ix, iz] = cellOf(cells.values().next().value!);
      const y = sampleFloor((ix + 0.5) * cell, (iz + 0.5) * cell, heightAt((ix + 0.5) * cell, (iz + 0.5) * cell));
      for (const ring of traceCells(new Map([...cells].map(k => [k, y])), cell, y)) {
        if (holes.some(h => ring.every(([x, , z]) => withinRing(h, x, z, OBSTACLE_CELL / 2)))) continue;
        out.push(onGround(ring.map(([x, , z]) => [x, sampleFloor(x, z, y), z] as Vertex)));
      }
    }
    return out;
  });
  /** Where a gap and an obstacle ring cover the same ground, only the bigger of the two shows:
   * a gap under a mountain is the mountain, and a rock inside a wide empty patch is the patch. */
  const gaps = createMemo<Ring[]>(() => {
    const { bulk: small, big } = previewRings();
    const rings = [...small, ...big];
    return rawGaps().filter(g => !rings.some(o => Math.abs(signedArea(o)) >= Math.abs(signedArea(g)) && mostlyInside(g, o)));
  });
  const shownPreview = createMemo(() => {
    const hide = (o: Ring) => rawGaps().some(g => Math.abs(signedArea(g)) > Math.abs(signedArea(o)) && mostlyInside(o, g));
    const { bulk: small, big } = previewRings();
    return { bulk: small.filter(o => !hide(o)), big: big.filter(o => !hide(o)) };
  });
  /** Why the empty-patch search found nothing, when it could not have found anything. */
  const gapsWhyNot = () =>
    !ctx.hasRoam() ? "turn on roam data to find them" : !memberTrailAll().length ? "none: no mob in this region has a roam trail" : undefined;
  const gapAt = (x: number, z: number) => gaps().find(g => inRing(g, x, z));
  /** True while a batch of holes is being cut, which takes the carve controls and map clicks out. */
  const [cutting, setCutting] = createSignal(false);
  /**
   * Cuts a hole for each ring, one at a time through the clipper, so a ring that overlaps an earlier
   * one becomes part of it and one that crosses the outline carves a bay rather than hanging
   * outside. A ring that would cut the region in two is skipped and counted, for the person to
   * handle. It yields every few rings: a few hundred of them is seconds of work, and a page that
   * stops painting for that long looks like it crashed.
   */
  const cutHoles = async (rings: Ring[], [one, many]: [string, string]) => {
    const name = activeName();
    const entry = regions().find(r => r.name === name);
    if (!name || !entry || !rings.length || cutting()) return;
    setCutting(true);
    let shape: Region = { rings: entry.rings.map(ring => ring.map(v => [...v] as Vertex)) };
    const outlineArea = Math.abs(signedArea(entry.rings[0]));
    let done = 0, skipped = 0;
    try {
      for (let i = 0; i < rings.length; i++) {
        if (i && i % 8 === 0) {
          flash(`cutting ${i} of ${rings.length} ${many}…`);
          await new Promise(resolve => setTimeout(resolve));
        }
        const joined = asOne(repairRegion({ rings: [...shape.rings, rings[i]] }), outlineArea);
        if (!joined) {
          skipped++;
          continue;
        }
        shape = joined;
        done++;
      }
    } finally {
      setCutting(false);
    }
    if (done) {
      checkpoint(done === 1 ? `cut ${one}` : `cut ${done} ${many}`);
      // Where a ring carved a bay, the clipper's new corners borrowed a neighbour's height; every
      // ring goes back onto the terrain so the outline does not dip under it.
      setRegions(rs => rs.map(r => (r.name === name ? { name, rings: shape.rings.map(onGround) } : r)));
      // Settled now rather than in 400ms, so what was just cut leaves the list before a second
      // click can cut it again.
      setSettled(regions());
      if (!skipped) flash(done === 1 ? `cut ${one}` : `cut ${done} ${many}`);
    }
    if (skipped) flash(`${skipped} of those would cut ${name} in two, so they were left alone`, "warn");
  };
  const cutRings = (rings: Ring[]) => cutHoles(rings, ["an empty patch", "empty patches"]);
  // One ring per obstacle, so a pocket of sampled ground fenced between two rocks costs only the
  // ring that closes it, not every ring merged with it; the clipper joins what overlaps.
  const ringObstacles = (list: Obstacle[]) =>
    cutHoles(list.flatMap(o => ringsAround([o], obstacleMargin(), OBSTACLE_CELL, walkedCells())).map(onGround), ["around an obstacle", "around obstacles"]);

  return {
    nearHoles,
    growClearance,
    setGrowClearance,
    growPlan,
    growHole,
    mergeReach,
    setMergeReach,
    mergePlan,
    mergeHoles,
    DIALS,
    resetObstacleDials,
    obstacleHover,
    setObstacleHover,
    isCliff,
    bulk,
    walkedCells,
    settledActive,
    obstacles,
    onGround,
    groundRing,
    gapMinArea,
    setGapMinArea,
    gaps,
    shownPreview,
    gapsWhyNot,
    gapAt,
    cutting,
    cutRings,
    ringObstacles,
    obstacleMargin,
    obstacleBulkMax,
  };
}
