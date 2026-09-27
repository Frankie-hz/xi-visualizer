import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { Line2, LineGeometry, LineMaterial, LineSegments2, LineSegmentsGeometry, MapControls } from "three/examples/jsm/Addons.js";
import { createMapCamera, fitCameraToContents } from "../graphics/camera";
import { buildNavMeshGroup, parseNavMesh } from "../graphics/navmesh";
import { beaconMaterial, cometMaterial, handleMaterial, roamMaterial, spawnMaterial } from "../graphics/region_points";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { createViewer } from "../graphics/viewer";
import { ColorKind, colorMesh, createZoneMesh, mapIdPerVertex, prepareMeshData } from "../graphics/ximesh";
import { cellKey, findObstacles, obstacleArea, obstacleAt, ringsAround } from "../obstacles";
import type { Obstacle } from "../obstacles";
import { containsXZ, regionAt, regionHue, regionsFromPoints, repairRegion, routeFromTrail, selfIntersects, simplifyRing, validate } from "../regions";
import type { Finding, Patrol, Region, RegionSet, Ring, Spawn, TrailPoint, Vertex } from "../regions";
import type { RoamData } from "../roam";
import MobList from "./region_mob_list";
import ShortcutsCard from "./region_shortcuts";
import type { ZoneData } from "./zone_model";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface RegionEntry extends Region {
  name: string;
}

interface Handle {
  ring: number;
  idx: number;
  mid: boolean;
}

interface RegionEditorProps {
  /** Looking rather than changing: the geometry tools go away and the canvas stops taking edits.
   * Everything for reading a zone -- roam trails, floors, labels, the review list -- stays. */
  readOnly?: boolean;
  zoneData: ZoneData;
  spawns: Spawn[];
  regions: RegionSet;
  /** Overrides the assignments carried on the spawns themselves, for restoring a draft. */
  assign?: Record<string, string[]>;
  /** Same, for patrol routes. */
  paths?: Record<string, Patrol>;
  roam?: RoamData;
  /** The zone's navmesh, drawn in place of the collision mesh while present. */
  nav?: ArrayBuffer;
  onChange: (regions: RegionSet, assign: Record<string, string[]>, paths: Record<string, Patrol>) => void;
}

// "obstacles" is a click mode too: each click rings the steep faces under it with a hole.
type Mode = "select" | "draw" | "obstacles";
/** Grid the collision mesh's steep faces are read on, in yalms. */
const OBSTACLE_CELL = 0.5;

const GOLDEN = 0.61803398875; // successive regions land far apart on the colour wheel
const PATH_COLOR = 0xa78bfa; // routes are violet, clear of the region hues and the cyan trails

export default function RegionEditor(props: RegionEditorProps) {
  let canvasElement: HTMLCanvasElement;
  let controls: MapControls | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => createMapCamera(20000));

  const [regions, setRegions] = createSignal<RegionEntry[]>(
    Object.entries(props.regions).map(([name, r]) => ({ name, ...r })),
  );
  const [assign, setAssign] = createSignal<Record<string, string[]>>(
    props.assign ?? Object.fromEntries(props.spawns.filter(s => s.regions?.length).map(s => [s.id, s.regions!])),
  );
  const [activeName, setActiveName] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<Mode>("select");
  // Patrol routes, keyed by the spawn that walks them. A spawn has a region or a route, never both.
  const [paths, setPaths] = createSignal<Record<string, Patrol>>(
    props.paths ?? Object.fromEntries(props.spawns.filter(s => s.path).map(s => [s.id, { legs: s.path!, loop: s.loop }])),
  );
  const [walker, setWalker] = createSignal<string | null>(null); // spawn whose route is being edited
  const [mirror, setMirror] = createSignal<string[]>([]); // mobs walking the same route as the walker
  const [filter, setFilter] = createSignal("");
  const [hideAssigned, setHideAssigned] = createSignal(true);
  const [tab, setTab] = createSignal<"regions" | "paths" | "review" | "history">("regions");
  const [terrainColors, setTerrainColors] = createSignal(true);
  // The floor being worked on, as a map sheet id. Null is the whole zone, which is all an outdoor
  // zone ever has.
  const [floors, setFloors] = createSignal<number[]>([]);
  const [floor, setFloor] = createSignal<number | null>(null);
  const [hover, setHover] = createSignal<{ spawn: Spawn; x: number; y: number; } | null>(null);
  // The hole under the cursor in the active region, for the marker and the context menu.
  const [holeHover, setHoleHover] = createSignal<{ name: string; index: number; x: number; y: number; } | null>(null);
  const inRing = (ring: Ring, x: number, z: number) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, , zi] = ring[i], [xj, , zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  /** Index of the hole ring of `r` that holds x/z, the smallest if they nest, or 0 for none. */
  const holeAt = (r: Region, x: number, z: number) => {
    let best = 0;
    let area = Infinity;
    for (let k = 1; k < r.rings.length; k++) {
      if (r.rings[k].length < 3 || !inRing(r.rings[k], x, z)) continue;
      const a = Math.abs(ringArea(r.rings[k]));
      if (a < area) (area = a, best = k);
    }
    return best;
  };
  const ringArea = (ring: Ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      sum += a[0] * b[2] - b[0] * a[2];
    }
    return sum / 2;
  };
  /** Shortest distance between two rings' edges, on x/z. */
  const ringDistance = (a: Ring, b: Ring) => {
    const segDist = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
      const dx = bx - ax, dz = bz - az;
      const t = dx || dz ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz))) : 0;
      return Math.hypot(px - ax - t * dx, pz - az - t * dz);
    };
    let best = Infinity;
    for (const [outer, inner] of [[a, b], [b, a]] as const) {
      for (const [px, , pz] of outer) {
        for (let i = 0; i < inner.length; i++) {
          const [ax, , az] = inner[i], [bx, , bz] = inner[(i + 1) % inner.length];
          best = Math.min(best, segDist(px, pz, ax, az, bx, bz));
        }
      }
    }
    return best;
  };
  /** Holes of the active region within `reach` yalms of hole `index`, itself excluded. */
  const nearHoles = (r: Region, index: number, reach = 2) =>
    r.rings.map((ring, k) => k).filter(k => k >= 1 && k !== index && r.rings[k].length >= 3 && ringDistance(r.rings[index], r.rings[k]) <= reach);
  const deleteHole = (name: string, index: number) => {
    checkpoint("delete a hole");
    setRegions(rs => rs.map(r => (r.name === name ? { name, rings: r.rings.filter((_, k) => k !== index) } : r)));
    setHoleHover(null);
  };
  /**
   * Merging is two steps: the menu opens a plan with a reach dial and a preview of the hull, and
   * Apply commits it. The merged hole is the convex hull of the group's vertices, since two
   * obstacles a mob cannot pass between are one obstacle to it. Undo brings the pieces back.
   */
  const [merge, setMerge] = createSignal<{ name: string; index: number; } | null>(null);
  const [mergeReach, setMergeReach] = createSignal(2);
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
    if (!plan || !m || !plan.hull) return flash("no other hole within reach");
    const { entry, group, hull } = plan;
    const rings = [...entry.rings.filter((_, k) => !group.includes(k)), hull];
    const pieces = repairRegion({ rings });
    checkpoint(`merge ${group.length} holes`);
    setRegions(rs => rs.map(r => (r.name === m.name ? { name: m.name, rings: (pieces.length === 1 ? pieces[0].rings : rings).map(onGround) } : r)));
    setHoleHover(null);
    setMerge(null);
    flash(`merged ${group.length} holes`);
  };
  const convexHull = (pts: Vertex[]): Ring => {
    const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const cross = (o: Vertex, a: Vertex, b: Vertex) => (a[0] - o[0]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[0] - o[0]);
    const lower: Vertex[] = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: Vertex[] = [];
    for (const p of [...sorted].reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(v => [...v] as Vertex);
  };
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [toast, setToast] = createSignal<string | undefined>();
  const [rowFocus, setRowFocus] = createSignal<string | null>(null);
  const [pinnedId, setPinnedId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<
    | { x: number; y: number; }
      & (
        | { kind: "region"; name: string; }
        | { kind: "hole"; name: string; index: number; }
        | { kind: "spawn"; spawn: Spawn; }
        | { kind: "route"; lead: string; }
      )
    | null
  >(null);

  // Hovering a dot on the map or a row in the member list picks out that mob's roam trail; clicking
  // the row pins it, so the trail stays put while you reshape the polygon around it.
  const focusId = () => hover()?.spawn.id ?? rowFocus() ?? pinnedId();
  const pinnedSpawn = () => props.spawns.find(s => s.id === pinnedId());
  const walkerSpawn = () => props.spawns.find(s => s.id === walker());

  const xyz = (p: THREE.Vector3) => [p.x, p.y, p.z].map(n => n.toFixed(3)).join(" ");

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** A note in the corner of the map that clears itself. */
  const flash = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 2400);
  };
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    flash(`copied ${text}`);
  };
  onCleanup(() => clearTimeout(toastTimer));

  const active = () => regions().find(r => r.name === activeName());
  const matches = (s: Spawn) => {
    const f = filter().toLowerCase();
    return !f || s.name.toLowerCase().includes(f) || s.id.includes(f);
  };
  const asSet = (list: RegionEntry[]): RegionSet => Object.fromEntries(list.map(r => [r.name, { rings: r.rings }]));

  // Colour by position, so each region added is visibly distinct from the last. Regions the list
  // no longer holds (a spawn pointing at a deleted one) fall back to the name hash.
  const hues = createMemo(() => {
    const map: Record<string, number> = {};
    regions().forEach((r, i) => (map[r.name] = (i * GOLDEN + 0.11) % 1));
    return map;
  });
  // Tolerates a missing name: Solid re-runs a Show's children once before tearing them down, so
  // these get called with the selection that just became null.
  const hueOf = (name?: string | null) => (name ? hues()[name] ?? regionHue(name) : 0);
  const colorOf = (name?: string | null) => new THREE.Color().setHSL(hueOf(name), 0.9, 0.6);
  const cssOf = (name?: string | null) => `hsl(${(hueOf(name) * 360).toFixed(0)} 90% 60%)`;

  createEffect(() => props.onChange(asSet(regions()), assign(), paths()));

  const spawnCounts = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const names of Object.values(assign())) {
      for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  });

  /**
   * Routes that are the same line, keyed by that line. A region converted into a patrol leaves every
   * mob it held walking one route, and stacking a label per mob on the same spot would bury it.
   */
  const routeGroups = createMemo(() => {
    const groups = new Map<string, { lead: string; ids: string[]; legs: Vertex[]; }>();
    for (const [id, patrol] of Object.entries(paths())) {
      if (patrol.legs.length < 2) continue;
      const key = patrol.legs.map(v => v.map(n => n.toFixed(1)).join(",")).join(";");
      const group = groups.get(key);
      if (group) group.ids.push(id);
      else groups.set(key, { lead: id, ids: [id], legs: patrol.legs });
    }
    return [...groups.values()];
  });

  /**
   * Mobs still placed by a fixed point, which are the ones left to do something about. They keep
   * their dot; this is the name beside it, so you can tell what you are looking at without hovering
   * every one.
   */
  const labelledSpawns = createMemo(() => {
    const a = assign();
    const p = paths();
    return props.spawns.filter(s => s.at && !a[s.id] && !p[s.id]);
  });

  /** Picks up a route for editing, with the mobs that share it, so one edit moves all of them. */
  const selectRoute = (id: string) => {
    const group = routeGroups().find(g => g.ids.includes(id));
    setActiveName(null);
    setWalker(group?.lead ?? id);
    setMirror(group ? group.ids.filter(other => other !== group.lead) : []);
    setTab("paths");
  };

  /**
   * The regions as they were once the mouse stopped moving.
   *
   * Dragging a vertex replaces the set on every mouse move, and the two things that read it are
   * far too expensive to run at that rate: checking every region for self-intersection is
   * quadratic in its vertices, and measuring trail coverage walks every roam point in the zone --
   * over two million of them in Pashhow Marshlands. Neither answer is wanted mid-drag anyway.
   * Nothing that draws uses this; the picture still follows the mouse exactly as before.
   */
  const [settled, setSettled] = createSignal(regions());
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const now = regions();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => setSettled(now), 400);
  });
  onCleanup(() => clearTimeout(settleTimer));

  // How much of a region's mobs' roam trails actually fall inside it: the objective version of
  // "does this polygon look right". Debounced and sampled, since it re-runs while dragging.
  const [coverage, setCoverage] = createSignal<Record<string, number>>({});
  let coverageTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const set = asSet(settled());
    const a = assign();
    const data = props.roam;
    const wanted = tab() === "review"; // the only place this number is shown
    clearTimeout(coverageTimer);
    if (!data || !wanted) return;
    coverageTimer = setTimeout(() => {
      const acc: Record<string, [number, number]> = {};
      for (const [id, names] of Object.entries(a)) {
        const range = data.ranges[id];
        if (!range) continue;
        const [start, count] = range;
        // Every point, not a sample of 120: this figure is what the review tab reports as "covers
        // N% of its mobs' trails", and estimating it from a twentieth of the data is fine for a
        // rough sort and misleading for the one number a reviewer trusts. Pashhow Marshlands has
        // 2,268,933 of them, so it is only paid for while that tab is open.
        for (const name of names) {
          const r = set[name];
          if (!r) continue;
          const tally = (acc[name] ??= [0, 0]);
          for (let i = 0; i < count; i++) {
            const o = (start + i) * 3;
            tally[1]++;
            if (containsXZ(r, data.positions[o], data.positions[o + 2])) tally[0]++;
          }
        }
      }
      setCoverage(Object.fromEntries(Object.entries(acc).map(([n, [inside, total]]) => [n, inside / total])));
    }, 300);
  });
  onCleanup(() => clearTimeout(coverageTimer));

  /**
   * Only while somebody is reading it, and once after a save.
   *
   * Checking every region for self-intersection is quadratic in its vertices, and the coverage
   * figure walks every roam point in the zone; running both behind a tab badge meant paying for an
   * answer nobody had asked for. Opening the tab computes it, and it stays live while it is open.
   * The badge shows what was found last time, which is what it was showing anyway.
   */
  /**
   * Whether what the badge shows still describes the regions as they are.
   *
   * The check only runs while its tab is open, so between times the number is a memory of an
   * older shape. Saying "?" is the honest version of that: a stale count that looks current is
   * worse than no count, because it is the one a reviewer would act on.
   */
  const [reviewStale, setReviewStale] = createSignal(true);
  // Only what was checked marks it stale. Reading the tab here as well would mean leaving the tab
  // invalidated a perfectly good answer, purely by looking away from it.
  createEffect(on([settled, assign, paths], () => {
    if (untrack(tab) !== "review") setReviewStale(true);
  }, { defer: true }));

  const findings = createMemo<Finding[]>(previous => {
    const thin: Finding[] = Object.entries(coverage())
      .filter(([, v]) => v < 0.9)
      .sort((a, b) => a[1] - b[1])
      .map(([name, v]) => ({
        level: v < 0.7 ? "warn" : "info",
        region: name,
        text: `${name} covers ${(v * 100).toFixed(0)}% of its mobs' trails`,
      }));
    if (tab() !== "review") return previous;
    queueMicrotask(() => setReviewStale(false));
    return [...thin, ...validate(asSet(settled()), props.spawns, assign())];
  }, []);

  /**
   * Every recorded point of the given mobs. Not thinned.
   *
   * This used to keep 400 points per mob, which drew 40% of the trail on a two thousand point mob
   * and hid exactly the thing a reviewer is looking for: a brief excursion -- over a hill, into a
   * corner -- is a handful of consecutive samples, and a stride of four erases it. Two mobs at one
   * spot in Valkurm vanished from the view completely while the region was correctly covering them.
   */
  const trailPoints = (ids: string[]): TrailPoint[] => {
    const data = props.roam;
    if (!data) return [];
    const out: TrailPoint[] = [];
    for (const id of ids) {
      const range = data.ranges[id];
      if (!range) continue;
      const [start, count] = range;
      for (let i = 0; i < count; i++) {
        const o = (start + i) * 3;
        out.push({ x: data.positions[o], y: data.positions[o + 1], z: data.positions[o + 2], t: data.times[start + i] });
      }
    }
    return out;
  };

  // --- history ---
  /**
   * What is being edited belongs in here with what is being edited, or undo puts them out of step:
   * undoing the conversion of a region into a patrol used to bring the region back while leaving the
   * editor holding the route that no longer existed.
   */
  interface Snapshot {
    regions: RegionEntry[];
    assign: Record<string, string[]>;
    paths: Record<string, Patrol>;
    activeName: string | null;
    walker: string | null;
    mirror: string[];
    mode: Mode;
  }
  interface Step {
    label: string;
    /** The state as it was before this step, which is what undoing it goes back to. */
    before: Snapshot;
  }
  const [undoStack, setUndoStack] = createSignal<Step[]>([]);
  const [redoStack, setRedoStack] = createSignal<Step[]>([]);
  const snap = (): Snapshot => ({
    regions: regions(),
    assign: assign(),
    paths: paths(),
    activeName: activeName(),
    walker: walker(),
    mirror: mirror(),
    mode: mode(),
  });
  const restore = (s: Snapshot) => {
    setRegions(s.regions);
    setAssign(s.assign);
    setPaths(s.paths);
    // Selection last, and only where there is something to select: a snapshot older than a rename
    // or a delete can still name one that has since gone, and pointing at it strands the editor.
    setActiveName(s.activeName && s.regions.some(r => r.name === s.activeName) ? s.activeName : null);
    setWalker(s.walker && s.paths[s.walker] ? s.walker : null);
    setMirror(s.mirror.filter(id => s.paths[id]));
    setMode(s.mode);
  };

  // Snapshots are taken at operation boundaries, so a whole vertex drag collapses into one step.
  // The label is what the step is called in the history list, so it names the change, not the click.
  const checkpoint = (label: string) => {
    setUndoStack(steps => [...steps, { label, before: snap() }].slice(-100));
    setRedoStack([]);
  };

  const undo = () => {
    const steps = undoStack();
    const step = steps[steps.length - 1];
    if (!step) return;
    setUndoStack(steps.slice(0, -1));
    setRedoStack(r => [...r, { label: step.label, before: snap() }]);
    restore(step.before);
  };

  const redo = () => {
    const steps = redoStack();
    const step = steps[steps.length - 1];
    if (!step) return;
    setRedoStack(steps.slice(0, -1));
    setUndoStack(u => [...u, { label: step.label, before: snap() }]);
    restore(step.before);
  };

  /** Steps back to just before the numbered step, so the history list is clickable. */
  const rewindTo = (index: number) => {
    for (let i = undoStack().length; i > index; i--) undo();
  };

  // --- obstacles: holes drawn around the collision mesh's steep faces ---
  // The dials: how far off the faces the ring sits, what counts as steep, how close faces must be
  // to be one obstacle, how tall and how wide an obstacle must be to show at all, and how big one
  // may be before "ring all" skips it.
  const OBSTACLE_DEFAULTS = { margin: 1, slope: 50, join: 1, minHeight: 0.5, minArea: 0.5, bulkMax: 150 };
  const [obstacleMargin, setObstacleMargin] = createSignal(OBSTACLE_DEFAULTS.margin); // yalms
  const [obstacleSlope, setObstacleSlope] = createSignal(OBSTACLE_DEFAULTS.slope); // degrees from level
  const [obstacleJoin, setObstacleJoin] = createSignal(OBSTACLE_DEFAULTS.join); // yalms
  const [obstacleMinHeight, setObstacleMinHeight] = createSignal(OBSTACLE_DEFAULTS.minHeight); // yalms
  const [obstacleMinArea, setObstacleMinArea] = createSignal(OBSTACLE_DEFAULTS.minArea); // square yalms of footprint
  const [obstacleBulkMax, setObstacleBulkMax] = createSignal(OBSTACLE_DEFAULTS.bulkMax); // square yalms of footprint
  const resetObstacleDials = () => {
    setObstacleMargin(OBSTACLE_DEFAULTS.margin);
    setObstacleSlope(OBSTACLE_DEFAULTS.slope);
    setObstacleJoin(OBSTACLE_DEFAULTS.join);
    setObstacleMinHeight(OBSTACLE_DEFAULTS.minHeight);
    setObstacleMinArea(OBSTACLE_DEFAULTS.minArea);
    setObstacleBulkMax(OBSTACLE_DEFAULTS.bulkMax);
  };
  const [obstacles, setObstacles] = createSignal<Obstacle[]>([]);
  const bulk = () => obstacles().filter(o => obstacleArea(o, OBSTACLE_CELL) <= obstacleBulkMax());
  /** The steep faces inside the active region on the current floor, clustered into obstacles. */
  const scanObstacles = () => {
    const r = active();
    if (!r || !zoneMesh || !floorIndex || (r.rings[0]?.length ?? 0) < 3) return setObstacles([]);
    const pos = zoneMesh.geometry.getAttribute("position").array as Float32Array;
    const only = floor();
    const up = Math.cos((obstacleSlope() * Math.PI) / 180);
    const minHeight = obstacleMinHeight();
    const minArea = obstacleMinArea();
    const perVertex = floorIndex.perVertex;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, , z] of r.rings[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const keep = (t: number) => {
      if (only !== null && perVertex[t * 3] !== only) return false;
      const o = t * 9;
      const x = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
      const z = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
      return x >= minX && x <= maxX && z >= minZ && z <= maxZ && containsXZ(r, x, z);
    };
    const found = findObstacles(pos, { cell: OBSTACLE_CELL, up, join: obstacleJoin(), keep });
    // Height is foot minus top because y points down.
    setObstacles(found.filter(o => o.foot - o.top >= minHeight && obstacleArea(o, OBSTACLE_CELL) >= minArea));
  };
  // Rescans whenever the region itself changes too: a ring just cut, or undone, moves obstacles
  // into or out of a hole, and the list of what is left to ring must follow.
  createEffect(on(
    [mode, activeName, floor, regions, obstacleSlope, obstacleJoin, obstacleMinHeight, obstacleMinArea],
    () => (mode() === "obstacles" ? scanObstacles() : setObstacles([])),
  ));
  /**
   * Terrain height under a ring vertex, found by dropping a ray through the zone mesh near the
   * obstacle's own foot. A ring around a rock on a slope needs each vertex on the ground beside
   * it, not all at one height, or it floats on the downhill side and buries on the uphill one.
   */
  const onGround = (ring: Ring): Ring => {
    const mesh = zoneMesh;
    if (!mesh) return ring;
    const ray = new THREE.Raycaster();
    return ring.map(([x, y, z]) => {
      // The scene is mirrored (see graphics/scene.ts), so the ray is set up in world space from
      // two zone points: from 30 yalms above the vertex straight down through it.
      const from = mesh.localToWorld(new THREE.Vector3(x, y - 30, z));
      const to = mesh.localToWorld(new THREE.Vector3(x, y + 30, z));
      ray.set(from, to.clone().sub(from).normalize());
      ray.far = from.distanceTo(to);
      const hits = ray.intersectObject(mesh, false);
      // The surface nearest the obstacle's foot, and only within a step of it: a bridge overhead,
      // a cave below, or the rock's own shoulder where the ring crosses it are not the ground the
      // mob stands on. With nothing that close the foot itself will do.
      let best = y;
      let gap = 3;
      for (const h of hits) {
        const p = mesh.worldToLocal(h.point.clone());
        if (Math.abs(p.y - y) < gap) (gap = Math.abs(p.y - y), best = p.y);
      }
      return [x, best, z] as Vertex;
    });
  };
  /** The cells the active region's own mobs were recorded in: a ring never takes those, since the
   * data has a mob standing there whatever the mesh says. */
  const walkedCells = createMemo(() => {
    const name = activeName();
    const out = new Set<number>();
    if (!name || mode() !== "obstacles") return out;
    const ids = props.spawns.filter(s => assign()[s.id]?.includes(name)).map(s => s.id);
    for (const p of trailPoints(ids)) out.add(cellKey(p.x, p.z, OBSTACLE_CELL));
    return out;
  });
  /** The rings the obstacles on offer would cut, merged where their margins meet: what Ring all
   * takes, and separately what is over its size and waits for a click. */
  const previewRings = createMemo(() => ({
    bulk: ringsAround(bulk(), obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround),
    big: ringsAround(obstacles().filter(o => !bulk().includes(o)), obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround),
  }));
  /**
   * Cuts a hole around each obstacle. Every ring goes through the clipper at once, so one that
   * overlaps another ring becomes part of it and one that crosses the outline carves a bay into
   * it rather than being left hanging outside. A ring that would cut the region in two is skipped
   * and counted, for the person to handle.
   */
  const ringObstacles = (list: Obstacle[]) => {
    const name = activeName();
    const entry = regions().find(r => r.name === name);
    if (!name || !entry || !list.length) return;
    const rings = ringsAround(list, obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround);
    let shape: Region = { rings: entry.rings.map(ring => ring.map(v => [...v] as Vertex)) };
    let done = 0;
    let skipped = 0;
    for (const ring of rings) {
      const pieces = repairRegion({ rings: [...shape.rings, ring] });
      if (pieces.length !== 1) {
        skipped++;
        continue;
      }
      shape = pieces[0];
      done++;
    }
    if (done) {
      checkpoint(done === 1 ? "ring an obstacle" : `ring ${done} obstacles`);
      // Where a ring carved a bay, the clipper's new corners borrowed a neighbour's height; every
      // ring goes back onto the terrain so the outline does not dip under it.
      setRegions(rs => rs.map(r => (r.name === name ? { name, rings: shape.rings.map(onGround) } : r)));
    }
    if (skipped) flash(`${skipped} ring${skipped === 1 ? "" : "s"} would cut ${name} in two; left alone`);
  };

  const editActive = (fn: (r: RegionEntry) => void) => {
    const name = activeName();
    setRegions(rs =>
      rs.map(r => {
        if (r.name !== name) return r;
        const copy: RegionEntry = { name: r.name, rings: r.rings.map(ring => ring.map(v => [...v] as Vertex)) };
        fn(copy);
        return copy;
      })
    );
  };

  /** The route being edited, if any. While one is selected it owns the handles instead of a region. */
  const activePath = () => {
    const id = walker();
    return id ? paths()[id] : undefined;
  };

  const editPath = (fn: (legs: Vertex[]) => void) => {
    const id = walker();
    if (!id) return;
    setPaths(all => {
      const current = all[id];
      if (!current) return all;
      const legs = current.legs.map(v => [...v] as Vertex);
      fn(legs);
      const next = { ...all, [id]: { ...current, legs } };
      for (const other of mirror()) if (next[other]) next[other] = { ...next[other], legs: legs.map(v => [...v] as Vertex) };
      return next;
    });
  };

  const mobs = (n: number) => `${n} mob${n === 1 ? "" : "s"}`;
  const fit = (coverage: number) => `${(coverage * 100).toFixed(0)}% of its trail is on it`;

  /**
   * Gives a mob a route, dropping whatever placed it before. Traced from its recorded trail when
   * there is one, since a patroller walks the same circuit over and over; otherwise you draw it.
   */
  const startPath = (spawn: Spawn) => {
    const traced = routeFromTrail(trailPoints([spawn.id]));
    checkpoint(`route for ${spawn.name}`);
    setAssign(a => {
      const next = { ...a };
      delete next[spawn.id];
      return next;
    });
    setPaths(all => ({ ...all, [spawn.id]: { legs: traced?.legs ?? all[spawn.id]?.legs ?? [] } }));
    setActiveName(null);
    editWalker(spawn.id);
    setMode(traced ? "select" : "draw");
    setTab("paths");
    flash(
      traced
        ? `traced ${traced.legs.length} legs, ${fit(traced.coverage)}`
        : trailPoints([spawn.id]).length < 30
        ? "no roam trail for that mob, click the legs out"
        : "its trail is a blob, not a route, click the legs out",
    );
  };

  /**
   * Turns a region into a patrol its mobs all walk. The route is traced from one member's trail,
   * the best fitting of the few with the most samples, since tracing their trails end to end would
   * just join up unrelated mobs. The region itself goes away because nothing is left in it.
   */
  const convertToPatrol = (name: string) => {
    const members = props.spawns.filter(s => assign()[s.id]?.includes(name));
    if (!members.length) return flash(`${name} has no mobs to convert`);
    const candidates = members
      .map(s => ({ s, samples: props.roam?.ranges[s.id]?.[1] ?? 0 }))
      .filter(m => m.samples >= 30)
      .sort((a, b) => b.samples - a.samples)
      .slice(0, 3)
      .map(m => ({ walker: m.s, route: routeFromTrail(trailPoints([m.s.id])) }))
      .filter(m => m.route)
      .sort((a, b) => b.route!.coverage - a.route!.coverage);
    const traced = candidates[0]?.route ?? null;
    const lead = candidates[0]?.walker ?? members[0];
    const legs = traced?.legs ?? [];

    checkpoint(`${name} to a patrol`);
    setPaths(all => {
      const next = { ...all };
      for (const m of members) next[m.id] = { legs: legs.map(v => [...v] as Vertex) };
      return next;
    });
    setAssign(a => {
      const next = { ...a };
      for (const m of members) delete next[m.id];
      return next;
    });
    setRegions(rs => rs.filter(r => r.name !== name));
    setActiveName(null);
    setWalker(lead.id);
    setMirror(members.map(m => m.id).filter(id => id !== lead.id));
    setMode(traced ? "select" : "draw");
    setTab("paths");
    flash(
      traced
        ? `${name} became a ${traced.legs.length} leg route for ${mobs(members.length)}, ${fit(traced.coverage)}`
        : `no repeating route in ${name}'s trails, click the legs out for all ${members.length}`,
    );
  };

  /** Selecting another mob's route ends any sharing the previous one had. */
  const editWalker = (id: string | null) => {
    if (id !== walker()) setMirror([]);
    setWalker(id);
  };

  /** Re-traces an existing route from the mob's trail, throwing away hand edits. */
  const retrace = (id: string) => {
    const traced = routeFromTrail(trailPoints([id]));
    if (!traced) return flash("no roam trail for that mob");
    checkpoint(`re-trace ${props.spawns.find(s => s.id === id)?.name ?? id}`);
    // Everyone who was walking the old line walks the new one: they were given it together.
    const sharing = routeGroups().find(g => g.ids.includes(id))?.ids ?? [id];
    selectRoute(id);
    setPaths(all => {
      const next = { ...all };
      for (const other of sharing) next[other] = { ...next[other], legs: traced.legs.map(v => [...v] as Vertex) };
      return next;
    });
    flash(`retraced ${traced.legs.length} legs, ${fit(traced.coverage)}`);
  };

  const dropPath = (id: string) => {
    checkpoint(`drop the route for ${props.spawns.find(s => s.id === id)?.name ?? id}`);
    setPaths(all => {
      const next = { ...all };
      delete next[id];
      return next;
    });
    if (walker() === id) editWalker(null);
  };

  /**
   * Rewrites a region as valid shapes. An outline that crosses itself describes two areas rather
   * than one, so repairing it can split the region, and the mobs follow whichever piece they stand
   * in. Their trails say where that is: a mob its region places has no coordinates of its own.
   */
  const repairShape = (name: string) => {
    const entry = regions().find(r => r.name === name);
    if (!entry) return;
    const pieces = repairRegion(entry);
    if (!pieces.length) return flash(`${name} has no shape left to repair`);
    if (pieces.length === 1 && !entry.rings.some(ring => selfIntersects(ring))) {
      return flash(`${name} is already a clean shape`);
    }

    const taken = new Set(regions().map(r => r.name));
    const named = pieces.map((piece, i) => {
      if (i === 0) return { name, rings: piece.rings };
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      taken.add(`${name}_${n}`);
      return { name: `${name}_${n}`, rings: piece.rings };
    });

    checkpoint(`repair ${name}`);
    setRegions(rs => rs.flatMap(r => (r.name === name ? named : [r])));
    if (named.length > 1) {
      setAssign(a => {
        const next = { ...a };
        for (const s of props.spawns) {
          if (!next[s.id]?.includes(name)) continue;
          const trail = trailPoints([s.id]);
          const at = trail.length
            ? { x: trail.reduce((t, p) => t + p.x, 0) / trail.length, z: trail.reduce((t, p) => t + p.z, 0) / trail.length }
            : s.at
            ? { x: s.x, z: s.z }
            : null;
          const piece = at && named.find(p => containsXZ(p, at.x, at.z));
          if (piece) next[s.id] = next[s.id].map(n => (n === name ? piece.name : n));
        }
        return next;
      });
    }
    setActiveName(name);
    flash(named.length > 1 ? `${name} was ${named.length} shapes, split them` : `repaired ${name}`);
  };

  const addRegion = () => {
    checkpoint("add a region");
    let n = regions().length + 1;
    while (regions().some(r => r.name === `region_${n}`)) n++;
    const name = `region_${n}`;
    setRegions(rs => [...rs, { name, rings: [[]] }]);
    setActiveName(name);
    setMode("draw");
  };

  // Returns false when the new name is empty or taken, so the input can snap back.
  const renameRegion = (from: string, raw: string) => {
    const to = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!to || regions().some(r => r.name === to && r.name !== from)) return false;
    if (to === from) return true;
    checkpoint(`rename ${from} to ${to}`);
    setRegions(rs => rs.map(r => (r.name === from ? { ...r, name: to } : r)));
    setAssign(a => Object.fromEntries(Object.entries(a).map(([id, ns]) => [id, ns.map(n => (n === from ? to : n))])));
    if (activeName() === from) setActiveName(to);
    return true;
  };

  const deleteRegion = (name: string) => {
    checkpoint(`delete ${name}`);
    setRegions(rs => rs.filter(r => r.name !== name));
    setAssign(a =>
      Object.fromEntries(
        Object.entries(a)
          .map(([id, ns]) => [id, ns.filter(n => n !== name)] as const)
          .filter(([, ns]) => ns.length),
      )
    );
    if (activeName() === name) setActiveName(null);
  };

  const assignInside = (remove: boolean) => {
    const r = active();
    if (!r) return;
    checkpoint(`assign what ${name} covers`);
    const set = asSet(regions());
    setAssign(a => {
      const next = { ...a };
      for (const s of props.spawns) {
        // A spawn whose region already replaced its `at:` has no position to test.
        if (!s.at || !matches(s) || regionAt(set, s.x, s.z, s.y) !== r.name) continue;
        if (remove) delete next[s.id];
        else next[s.id] = [r.name];
      }
      return next;
    });
  };

  // Keeps the current view angle and distance, just slides the camera over. Scene is flipped on y/z.
  const flyTo = (x: number, y: number, z: number) => {
    if (!controls) return;
    const center = new THREE.Vector3(x, -y, -z);
    const offset = new THREE.Vector3().subVectors(camera().position, controls.target);
    controls.target.copy(center);
    camera().position.copy(center).add(offset);
  };

  /** Centres on a region and pulls the camera in or out so the whole outline fits the view,
   * keeping the direction it is looked at from. */
  const zoomTo = (name: string) => {
    const r = regions().find(x => x.name === name);
    if (!r?.rings[0]?.length || !controls) return;
    const box = new THREE.Box3();
    for (const [x, y, z] of r.rings[0]) box.expandByPoint(new THREE.Vector3(x, -y, -z));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const cam = camera();
    const fov = (cam.fov * Math.PI) / 180;
    // Straight down the outline spans x and z; from an angle it foreshortens, so this is the
    // distance that fits it seen from above, with a fifth of margin.
    const need = Math.max(size.z / (2 * Math.tan(fov / 2)), size.x / (2 * Math.tan(fov / 2) * cam.aspect)) * 1.2;
    const direction = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
    controls.target.copy(center);
    cam.position.copy(center).addScaledVector(direction, Math.max(need, 20));
    controls.update();
  };

  const centerOn = (name: string) => {
    const r = regions().find(x => x.name === name);
    if (!r?.rings[0]?.length) return;
    const box = new THREE.Box3();
    for (const [x, y, z] of r.rings[0]) box.expandByPoint(new THREE.Vector3(x, y, z));
    const center = box.getCenter(new THREE.Vector3());
    flyTo(center.x, center.y, center.z);
    setActiveName(name);
  };

  // Walks the list one region at a time without touching the view angle, holding that region's
  // first mob so its dot and trail are on screen. For sweeping a zone from a low angle for a
  // vertex that landed on a wall, which is invisible from straight above.
  const stepRegion = (dir: 1 | -1) => {
    const list = regions().filter(onRegionFloor);
    if (!list.length) return;
    const i = list.findIndex(r => r.name === activeName());
    const next = list[(i + dir + list.length) % list.length];
    centerOn(next.name);
    setPinnedId(props.spawns.find(s => assign()[s.id]?.includes(next.name))?.id ?? null);
  };

  const members = createMemo(() => {
    const name = activeName();
    if (!name) return [];
    return props.spawns.filter(s => assign()[s.id]?.includes(name) && matches(s));
  });

  /** Rebuilds the active region's shape from the roam trails of the mobs assigned to it. */
  const refitActive = () => {
    const r = active();
    if (!r) return;
    const built = regionsFromPoints(trailPoints(Object.keys(assign()).filter(id => assign()[id]?.includes(r.name))));
    if (!built.length) return flash("no roam trails for that region's mobs");
    checkpoint(`refit ${r.name}`);
    setRegions(rs => rs.map(x => (x.name === r.name ? { name: r.name, rings: built[0].rings } : x)));
    if (built.length > 1) flash(`those trails form ${built.length} clusters, fitted the biggest`);
  };

  /** Builds a new region around a set of mobs' trails and assigns them (plus anything inside it). */
  const buildFrom = (spawns: Spawn[]) => {
    const built = regionsFromPoints(trailPoints(spawns.map(s => s.id)));
    if (!built.length) return flash("no roam trails for those mobs");

    // Named after whichever template dominates the selection, since that is what it will hold.
    const common = spawns.map(s => s.name).sort((a, b) => spawns.filter(s => s.name === b).length - spawns.filter(s => s.name === a).length)[0] ?? "region";
    const base = common.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const taken = new Set(regions().map(r => r.name));
    const named = built.map((region, i) => {
      let name = i ? `${base}_${i + 1}` : base;
      for (let n = built.length + 1; taken.has(name); n++) name = `${base}_${n}`;
      taken.add(name);
      return { name, rings: region.rings };
    });

    checkpoint("build regions from the trails");
    setRegions(rs => [...rs, ...named]);
    setAssign(a => {
      const next = { ...a };
      for (const s of spawns) {
        // Whichever cluster actually holds this mob: its trail if there is one, else its spawn point.
        const trail = props.roam?.ranges[s.id];
        const home = named.find(r =>
          trail
            ? containsXZ(r, props.roam!.positions[trail[0] * 3], props.roam!.positions[trail[0] * 3 + 2])
            : s.at && containsXZ(r, s.x, s.z)
        );
        if (home) next[s.id] = [home.name];
      }
      return next;
    });
    setActiveName(named[0].name);
    if (named.length > 1) flash(`built ${named.length} regions, one per cluster`);
  };

  const unassign = (id: string) => {
    checkpoint(`unassign ${name}`);
    setAssign(a => {
      const next = { ...a };
      delete next[id];
      return next;
    });
  };

  // --- replaying a trail ---
  /**
   * Walks a mob's samples in the order they were captured, as a comet: a bright head where it is
   * and a tail of where it just came from, which is the only way to see which way round it goes.
   * A still trail cannot show direction, and direction is what tells a patrol from a wanderer.
   */
  const REPLAY_RATE = 3; // samples a second at 1x, with the head gliding between them
  const REPLAY_TAIL = 24;
  const SPEEDS = [0.5, 1, 2, 4];
  const [replayId, setReplayId] = createSignal<string | null>(null);
  const [replayAt, setReplayAt] = createSignal(0);
  const [replaySpeed, setReplaySpeed] = createSignal(1);

  const replayTrail = createMemo(() => {
    const id = replayId();
    return id ? trailPoints([id]) : [];
  });

  const replaySpawn = () => props.spawns.find(s => s.id === replayId());

  /**
   * How long the mob has been walking without anyone losing sight of it, and a word when the
   * playhead crosses the moment they did. Counting from the first sample instead would report the
   * span of the archive, which for these captures is months: watching a mob cross the zone is not
   * "1500 hours in", and the jump you just saw is the part that needs explaining.
   */
  const BREAK = 120; // seconds without a sample before the mob may have gone anywhere
  const replayClock = createMemo(() => {
    const trail = replayTrail();
    const at = Math.min(replayAt(), trail.length - 1);
    if (at < 1 || trail[0].t === undefined) return "";

    const since = (trail[at].t ?? 0) - (trail[at - 1].t ?? 0);
    const spell = (s: number) => s > 86400 ? `${Math.round(s / 86400)} days` : s > 3600 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 60)} minutes`;
    if (since > BREAK) return `jumped, ${spell(since)} unwatched`;

    let from = at;
    while (from > 0 && (trail[from].t ?? 0) - (trail[from - 1].t ?? 0) <= BREAK) from--;
    const walked = (trail[at].t ?? 0) - (trail[from].t ?? 0);
    return walked < 60 ? `${Math.round(walked)} seconds in` : `${spell(walked)} in`;
  });

  // Picking a region or a route on the map is also picking it in the list, which is no use if the
  // list is scrolled somewhere else or showing another tab entirely.
  createEffect(() => {
    const row = activeName() ?? walker();
    if (!row) return;
    setTab(activeName() ? "regions" : "paths");
    requestAnimationFrame(() => rowRefs.get(row)?.scrollIntoView({ block: "nearest" }));
  });

  // --- three.js ---
  const overlay = new THREE.Group();

  const beaconGeo = new THREE.BufferGeometry();
  beaconGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  const beacon = new THREE.Points(beaconGeo, beaconMaterial());
  beacon.renderOrder = 8;
  beacon.visible = false;
  const stalkGeo = new LineGeometry();
  stalkGeo.setPositions([0, 0, 0, 0, 0, 0]);
  const stalkMaterial = new LineMaterial({ color: 0xfff066, linewidth: 2, depthTest: false, transparent: true });
  const stalk = new Line2(stalkGeo, stalkMaterial);
  stalk.renderOrder = 8;
  stalk.visible = false;
  let menuElement: HTMLDivElement | undefined;
  const rowRefs = new Map<string, HTMLDivElement>();
  const labelRefs = new Map<string, HTMLDivElement>();
  const pathLabelRefs = new Map<string, HTMLDivElement>();
  const spawnLabelRefs = new Map<string, HTMLDivElement>();
  const handleMap: Handle[] = [];
  const activeLineMaterials: LineMaterial[] = [];
  const obstacleLineMaterials: LineMaterial[] = [];
  const drawnSpawns: number[] = [];
  let handlePoints: THREE.Points | undefined;
  let spawnPoints: THREE.Points | undefined;
  let roamPoints: THREE.Points | undefined;
  let lastFocusRange: [number, number] | undefined;
  let zoneMesh: THREE.Mesh | undefined;
  let floorIndex: FloorIndex | undefined;
  let meshPrep: ReturnType<typeof prepareMeshData> | undefined;
  let drag: { ring: number; idx: number; } | null = null;
  let spawnDrag: { spawn: Spawn; line: THREE.Line; } | null = null;

  /**
   * Which floor everything is on, looked up by position. Buckets every triangle of the zone mesh by
   * its footprint, so a point picks the piece of ground under it rather than the one a few floors
   * up, which is the whole difficulty with a tower drawn from above.
   */
  interface FloorIndex {
    /** Map sheets with real geometry on them, in order. One entry means the zone has no floors. */
    floors: number[];
    at: (x: number, y: number, z: number) => number | null;
    perVertex: Uint8Array;
  }
  /** Roam points drawn at once. Above this a zone is sampled for display only; see where it is used. */
  const DRAWN_POINT_CAP = 600_000;

  const CELL = 12;
  const buildFloorIndex = (mesh: THREE.Mesh, prep: ReturnType<typeof prepareMeshData>): FloorIndex => {
    const perVertex = mapIdPerVertex(mesh, prep);
    const pos = mesh.geometry.getAttribute("position");
    const buckets = new Map<string, { y: number; map: number; }[]>();
    const counts = new Map<number, number>();

    for (let t = 0; t < pos.count; t += 3) {
      const map = perVertex[t];
      counts.set(map, (counts.get(map) ?? 0) + 1);
      // Geometry in this scene is in zone coordinates: the flip to world space lives on the
      // scene's scale, not in the buffers, and the regions drawn over it are stored the same way.
      const x = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      const y = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
      const z = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
      const key = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
      const cell = buckets.get(key);
      if (cell) cell.push({ y, map });
      else buckets.set(key, [{ y, map }]);
    }

    // Sheets carrying a handful of triangles are stray scenery, not somewhere anyone stands.
    const floors = [...counts].filter(([, n]) => n > 50).map(([map]) => map).sort((a, b) => a - b);

    return {
      floors,
      perVertex,
      at: (x, y, z) => {
        const cx = Math.round(x / CELL);
        const cz = Math.round(z / CELL);
        // Widening, because the middle of a region can be a courtyard with no floor under it at all.
        for (let ring = 1; ring <= 4; ring++) {
          let best: number | null = null;
          let nearest = Infinity;
          for (let dx = -ring; dx <= ring; dx++) {
            for (let dz = -ring; dz <= ring; dz++) {
              for (const entry of buckets.get(`${cx + dx},${cz + dz}`) ?? []) {
                const gap = Math.abs(entry.y - y);
                if (gap < nearest) (nearest = gap, best = entry.map);
              }
            }
          }
          if (best !== null) return best;
        }
        return null;
      },
    };
  };

  createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.Materials);
    // ximesh writes byte colours without flagging them normalized, which blows them out to white.
    // Fixing that plus dimming the material keeps the terrain readable *under* the overlay.
    (mesh.geometry.getAttribute("color") as THREE.BufferAttribute).normalized = true;
    (mesh.material as THREE.MeshBasicMaterial).color.setScalar(0.75);
    zoneMesh = mesh;
    mesh.visible = !untrack(() => props.nav);
    meshPrep = prep;
    floorIndex = buildFloorIndex(mesh, prep);
    setFloors(floorIndex.floors);
    setFloor(null);
    scene().add(mesh);
    scene().add(overlay);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
  });

  createEffect(() => {
    const kind = terrainColors() ? ColorKind.Materials : ColorKind.None;
    if (zoneMesh && meshPrep) colorMesh(zoneMesh, meshPrep, kind);
  });

  // The navmesh stands in for the terrain: both at once is unreadable. The collision mesh stays
  // underneath, hidden, since clicks and floors still read off it.
  createEffect(() => {
    const bytes = props.nav;
    if (zoneMesh) zoneMesh.visible = !bytes;
    if (!bytes) return;
    const group = buildNavMeshGroup(parseNavMesh(bytes), {
      showSurface: true,
      showEdges: true,
      colorByTile: false,
      colorByComponent: false,
      showOffMesh: false,
      joinByLinks: false,
      opacity: 0.55,
    });
    scene().add(group);
    onCleanup(() => {
      scene().remove(group);
      cleanupNode(group);
    });
  });

  /**
   * Draws one floor by indexing the mesh down to its triangles. Dimming the rest would not help:
   * seen from above, the thing in the way is the floor above the one being edited, and it has to go
   * rather than merely darken. Indexing takes the terrain out of the raycast with it, so clicks land
   * on the floor on screen, and the bounds tree is rebuilt because it describes what is indexed.
   */
  createEffect(() => {
    const only = floor();
    const mesh = zoneMesh;
    const index = floorIndex;
    if (!mesh || !index) return;

    if (only === null) {
      mesh.geometry.setIndex(null);
    } else {
      const keep: number[] = [];
      for (let t = 0; t < index.perVertex.length; t += 3) {
        if (index.perVertex[t] === only) keep.push(t, t + 1, t + 2);
      }
      mesh.geometry.setIndex(keep);
    }
    mesh.geometry.disposeBoundsTree();
    mesh.geometry.computeBoundsTree();
  });

  const trailFloors = createMemo(() => {
    const data = props.roam;
    const out: Record<string, number | null> = {};
    if (!data || !floorIndex) return out;
    for (const [id, [start, count]] of Object.entries(data.ranges)) {
      if (!count) continue;
      const o = (start + (count >> 1)) * 3;
      out[id] = floorIndex.at(data.positions[o], data.positions[o + 1], data.positions[o + 2]);
    }
    return out;
  });

  // Worked out once each rather than per frame: the answer only moves when the shapes do, and this
  // is read for every region and every mob on the way to placing their labels.
  const regionFloors = createMemo(() => {
    const out: Record<string, number | null> = {};
    if (!floorIndex) return out;
    for (const r of regions()) {
      const ring = r.rings[0];
      if (!ring?.length) continue;
      const votes = new Map<number, number>();
      for (const v of ring) {
        const on = floorIndex.at(v[0], v[1], v[2]);
        if (on !== null) votes.set(on, (votes.get(on) ?? 0) + 1);
      }
      out[r.name] = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }

    return out;
  });

  /**
   * Which floor a mob is on, by whatever places it. A mob its region places carries no coordinates,
   * so asking its own position would put every one of them nowhere the moment a floor is picked.
   */
  const spawnFloors = createMemo(() => {
    const out: Record<string, number | null> = {};
    if (!floorIndex) return out;
    const byRegion = regionFloors();
    const byTrail = trailFloors();
    const a = assign();
    const p = paths();
    for (const s of props.spawns) {
      const legs = p[s.id]?.legs;
      out[s.id] = a[s.id]?.length
        ? byRegion[a[s.id][0]] ?? null
        : legs?.length
        ? floorIndex.at(legs[0][0], legs[0][1], legs[0][2])
        : s.at
        ? floorIndex.at(s.x, s.y, s.z)
        : byTrail[s.id] ?? null;
    }
    return out;
  });

  // A trail is hidden or shown whole. A mob that walks a ramp between two floors belongs to both,
  // and half a trail appearing out of nowhere reads worse than one that is simply there.
  createEffect(() => {
    const data = props.roam;
    const points = roamPoints;
    const only = floor();
    if (!data || !points) return;
    const shown = points.geometry.getAttribute("shown") as THREE.BufferAttribute;
    const floors = trailFloors();
    for (const [id, [start, count]] of Object.entries(data.ranges)) {
      const visible = only === null || floors[id] === only ? 1 : 0;
      for (let i = start; i < start + count; i++) shown.setX(i, visible);
    }
    shown.needsUpdate = true;
  });

  // Fail open: something the mesh could not place shows on every floor rather than on none, or it
  // could never be selected again.
  const onRegionFloor = (r: RegionEntry) => {
    const on = regionFloors()[r.name];
    return floor() === null || on === undefined || on === null || on === floor();
  };
  const onFloor = (x: number, y: number, z: number) => floor() === null || !floorIndex || floorIndex.at(x, y, z) === floor();
  const spawnOnFloor = (s: Spawn) => {
    const on = spawnFloors()[s.id];
    return floor() === null || on === undefined || on === null || on === floor();
  };

  // Recorded roam trails, drawn under everything so a polygon can be checked against where the
  // mobs actually went.
  createEffect(() => {
    const data = props.roam;
    roamPoints = undefined;
    if (!data) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
    geo.setAttribute("big", new THREE.BufferAttribute(new Float32Array(data.count), 1));
    // Everything is on screen until a floor says otherwise.
    geo.setAttribute("shown", new THREE.BufferAttribute(new Float32Array(data.count).fill(1), 1));

    // Draw every nth point once a zone has more of them than a screen can distinguish. Pashhow
    // Marshlands records 2,268,933, against West Ronfaure's 682,000, and rasterising all of them
    // every frame is what makes it drag. Which points are drawn is chosen by an index, so the
    // buffers keep their original layout and everything that addresses a point by its position in
    // them -- colours, floors, hover, and the coverage figure -- is untouched and still exact.
    const stride = Math.max(1, Math.ceil(data.count / DRAWN_POINT_CAP));
    if (stride > 1) {
      const kept = Math.ceil(data.count / stride);
      const index = new Uint32Array(kept);
      for (let i = 0, at = 0; at < kept; i += stride) index[at++] = i;
      geo.setIndex(new THREE.BufferAttribute(index, 1));
    }

    const points = new THREE.Points(geo, roamMaterial());
    points.renderOrder = 0;
    roamPoints = points;
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geo.dispose();
      (points.material as THREE.Material).dispose();
    });
  });

  // The obstacles on offer, each drawn as the ring a click would cut, so the margin is visible
  // before anything is changed.
  createEffect(() => {
    const { bulk: small, big } = previewRings();
    if (!small.length && !big.length) return;
    const added: { lines: LineSegments2; geo: LineSegmentsGeometry; }[] = [];
    // Two colours: what Ring all takes in full amber, what is over its size dimmer.
    for (const [rings, key, color] of [[small, "obstacles", 0xffb020], [big, "obstacles-big", 0x8a6a2a]] as const) {
      if (!rings.length) continue;
      const segments: number[] = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          // A hair above the ground so the line is not swallowed by the terrain it lies on.
          segments.push(a[0], a[1] - 0.2, a[2], b[0], b[1] - 0.2, b[2]);
        }
      }
      // WebGL draws LineBasicMaterial one pixel wide whatever it is told, so this is a wide line
      // like the selected outline, sized in screen pixels. Segments geometry, not LineGeometry:
      // that one takes a polyline and would join every ring to the next.
      const geo = new LineSegmentsGeometry();
      geo.setPositions(segments);
      const mat = materialFor(key, () => new LineMaterial({ color, linewidth: 2.5, depthTest: false })) as LineMaterial;
      mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
      obstacleLineMaterials.push(mat);
      const lines = new LineSegments2(geo, mat);
      lines.renderOrder = 3;
      scene().add(lines);
      added.push({ lines, geo });
    }
    onCleanup(() => {
      for (const { lines, geo } of added) {
        scene().remove(lines);
        geo.dispose();
      }
    });
  });

  // The merge plan: the hull the group would become, and the holes going into it.
  createEffect(() => {
    const plan = mergePlan();
    if (!plan) return;
    const segments: number[] = [];
    const push = (ring: Ring) => {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        segments.push(a[0], a[1] - 0.25, a[2], b[0], b[1] - 0.25, b[2]);
      }
    };
    for (const k of plan.group) push(plan.entry.rings[k]);
    if (plan.hull) push(plan.hull);
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segments);
    const mat = materialFor("merge", () => new LineMaterial({ color: 0xc084fc, linewidth: 2.5, depthTest: false })) as LineMaterial;
    mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
    obstacleLineMaterials.push(mat);
    const lines = new LineSegments2(geo, mat);
    lines.renderOrder = 4;
    scene().add(lines);
    onCleanup(() => {
      scene().remove(lines);
      geo.dispose();
    });
  });

  // The active region's own mobs light up in its colour; everything else stays a dim backdrop.
  createEffect(() => {
    const data = props.roam;
    const points = roamPoints;
    if (!data || !points) return;
    const a = assign();
    const act = activeName();
    const colors = points.geometry.getAttribute("color") as THREE.BufferAttribute;
    // Cyan is the roam palette, kept clear of the white a spawn point uses. Trails fade back only
    // when the selected region has mobs to contrast against; dimming them all would leave specks.
    const highlighting = !!act && Object.keys(data.ranges).some(id => a[id]?.includes(act));
    const dim = highlighting ? new THREE.Color(0.16, 0.34, 0.42) : new THREE.Color(0.3, 0.75, 0.9);
    const lit = act ? colorOf(act) : dim;
    for (const [mobId, [start, count]] of Object.entries(data.ranges)) {
      const c = act && a[mobId]?.includes(act) ? lit : dim;
      for (let i = 0; i < count; i++) colors.setXYZ(start + i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  });

  // Focusing one mob only touches its own slice of the buffer, so it can follow the cursor.
  createEffect(() => {
    const data = props.roam;
    const points = roamPoints;
    if (!data || !points) return;
    const id = focusId();
    const big = points.geometry.getAttribute("big") as THREE.BufferAttribute;
    for (const range of [lastFocusRange, id ? data.ranges[id] : undefined]) {
      if (!range) continue;
      const value = range === data.ranges[id!] ? 1 : 0;
      for (let i = range[0]; i < range[0] + range[1]; i++) big.setX(i, value);
    }
    lastFocusRange = id ? data.ranges[id] : undefined;
    big.needsUpdate = true;
    (points.material as THREE.ShaderMaterial).uniforms.focused.value = lastFocusRange ? 1 : 0;
  });

  /**
   * Where to point at the mob being hovered. Its own fixed point when it has one, the start of its
   * route otherwise, and nothing at all for a mob a region places, which has no position to mark.
   */
  const focusPoint = createMemo<Vertex | null>(() => {
    const id = focusId();
    if (!id) return null;
    const spawn = props.spawns.find(s => s.id === id);
    if (spawn?.at) return [spawn.x, spawn.y, spawn.z];
    const legs = paths()[id]?.legs;
    return legs?.length ? [...legs[0]] : null;
  });

  // A ring and a stalk on the mob being pointed at. Highlighting its roam trail says nothing about
  // a mob that has no trail, and those are exactly the ones whose single dot is hardest to find.
  createEffect(() => {
    const at = focusPoint();
    beacon.visible = stalk.visible = !!at;
    if (!at) return;
    const pos = beacon.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, at[0], at[1], at[2]);
    pos.needsUpdate = true;
    // Zone y counts downwards, so the top of the stalk is the smaller number.
    stalk.geometry.setPositions([at[0], at[1] - 14, at[2], at[0], at[1], at[2]]);
  });

  // Rebuilt whenever what is drawn changes; drawnSpawns maps geometry index -> props.spawns index,
  // so hidden spawns are neither drawn nor pickable.
  createEffect(() => {
    const a = assign();
    const hide = hideAssigned();
    const gray = new THREE.Color(0.9, 0.9, 0.9);

    drawnSpawns.length = 0;
    const pos: number[] = [];
    const col: number[] = [];
    props.spawns.forEach((s, i) => {
      const names = a[s.id];
      if (!s.at) return; // its region places it now, there is no dot to draw
      if (names?.length && hide) return;
      if (!spawnOnFloor(s)) return;
      drawnSpawns.push(i);
      pos.push(s.x, s.y, s.z);
      // Several regions means the server picks one at random; the dot takes the first one's colour.
      const c = names?.length ? colorOf(names[0]) : gray;
      const dim = matches(s) ? 1 : 0.2;
      col.push(c.r * dim, c.g * dim, c.b * dim);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setAttribute("mid", new THREE.BufferAttribute(new Float32Array(drawnSpawns.length), 1));
    const points = new THREE.Points(geo, spawnMaterial());
    points.renderOrder = 4;
    spawnPoints = points;
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geo.dispose();
      (points.material as THREE.Material).dispose();
    });
  });

  // Materials are decided by a colour and a role, nothing else, so there are only ever a handful of
  // distinct ones however many regions there are. Building them fresh on every rebuild meant a
  // vertex drag allocated dozens a frame and made the renderer set up a program for each, which is
  // work that shows up as a stall in the middle of the drag. Made once, kept, disposed at the end.
  // The vertex handles are drawn with a custom shader, and it was built anew on every rebuild --
  // so a vertex drag asked the renderer for a fresh shader program on every frame of the drag,
  // which is the one thing in here that stalls rather than merely costs.
  const handleMat = handleMaterial();
  onCleanup(() => handleMat.dispose());

  const overlayMaterials = new Map<string, THREE.Material>();
  const materialFor = <T extends THREE.Material>(key: string, make: () => T): T => {
    const had = overlayMaterials.get(key);
    if (had) return had as T;
    const made = make();
    overlayMaterials.set(key, made);
    return made;
  };
  onCleanup(() => {
    for (const m of overlayMaterials.values()) m.dispose();
    overlayMaterials.clear();
  });

  createEffect(() => {
    const list = regions();
    const activeRegion = active();
    while (overlay.children.length) {
      const child = overlay.children.pop() as THREE.Mesh;
      // Geometry is rebuilt every time and is this object's own; materials are shared and outlive it.
      child.geometry?.dispose();
    }
    handleMap.length = 0;
    activeLineMaterials.length = 0;
    handlePoints = undefined;

    for (const r of list) {
      if (!onRegionFloor(r)) continue;
      const isActive = r.name === activeRegion?.name;
      // Editing one polygon means the others are only in the way, and so do all of them while a
      // route is being worked on.
      if (activeRegion && !isActive) continue;
      if (walker()) continue;
      const color = colorOf(r.name);

      // Fill follows the floor: triangulate on x/z (as earcut does) and keep each vertex's own y.
      if ((r.rings[0]?.length ?? 0) >= 3) {
        const flat = [r.rings[0], ...r.rings.slice(1).filter(h => h.length >= 3)];
        const faces = THREE.ShapeUtils.triangulateShape(
          flat[0].map(([x, , z]) => new THREE.Vector2(x, -z)),
          flat.slice(1).map(h => h.map(([x, , z]) => new THREE.Vector2(x, -z))),
        );
        const verts = flat.flat();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts.flat()), 3));
        geo.setIndex(faces.flat());
        const fill = new THREE.Mesh(
          geo,
          materialFor(
            `fill:${color.getHex()}:${isActive}`,
            () =>
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: isActive ? 0.45 : 0.3,
                side: THREE.DoubleSide,
                depthTest: false,
              }),
          ),
        );
        fill.renderOrder = 1;
        overlay.add(fill);
      }

      for (const ring of r.rings) {
        if (ring.length < 2) continue;
        if (isActive) {
          // WebGL ignores LineBasicMaterial.linewidth, so the selected outline is drawn as Line2,
          // which builds screen-space quads and can actually be thick.
          const pts = ring.flat();
          pts.push(...ring[0]); // Line2 has no loop mode
          const geo = new LineGeometry();
          geo.setPositions(pts);
          const mat = materialFor(
            `outline:${color.getHex()}`,
            () => new LineMaterial({ color: color.getHex(), linewidth: 3, depthTest: false }),
          );
          mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
          activeLineMaterials.push(mat);
          const line = new Line2(geo, mat);
          line.renderOrder = 3;
          overlay.add(line);
        } else {
          const geo = new THREE.BufferGeometry().setFromPoints(ring.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
          const line = new THREE.LineLoop(
            geo,
            materialFor(
              `loop:${color.getHex()}`,
              () => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }),
            ),
          );
          line.renderOrder = 2;
          overlay.add(line);
        }
      }
    }

    // Patrol routes: a line through the legs, closed when it loops, waypoints as dots.
    for (const [id, patrol] of Object.entries(paths())) {
      if (patrol.legs.length < 2) continue;
      const editing = id === walker();
      const points = patrol.legs.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      if (patrol.loop !== false) points.push(points[0].clone());
      // Drawn twice, dark and wide under bright and narrow, the way a road is cased on a map.
      // A single violet line disappears the moment it crosses a region of a similar hue.
      const flat = points.flatMap(v => [v.x, v.y, v.z]);
      for (const [color, width, order] of [[0x0b0b12, 7, 2], [PATH_COLOR, 3.5, 3]] as const) {
        const geo = new LineGeometry();
        geo.setPositions(flat);
        const mat = materialFor(
          `route:${color}:${width}:${editing}`,
          () => new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true, opacity: editing ? 1 : 0.75 }),
        );
        mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        activeLineMaterials.push(mat);
        const line = new Line2(geo, mat);
        line.renderOrder = order;
        overlay.add(line);
      }

      const dots = new THREE.BufferGeometry().setFromPoints(patrol.legs.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      const marks = new THREE.Points(
        dots,
        materialFor(
          `waypoints:${editing}`,
          () => new THREE.PointsMaterial({ color: PATH_COLOR, size: editing ? 7 : 5, sizeAttenuation: false, depthTest: false }),
        ),
      );
      marks.renderOrder = 3;
      overlay.add(marks);
    }

    // A selected route owns the handles; only one thing is editable at a time.
    const patrol = activePath();
    if (patrol && patrol.legs.length) {
      const color = new THREE.Color(PATH_COLOR);
      const pos: number[] = [];
      const col: number[] = [];
      const mid: number[] = [];
      patrol.legs.forEach(([x, y, z], i) => {
        pos.push(x, y, z);
        col.push(color.r, color.g, color.b);
        mid.push(0);
        handleMap.push({ ring: 0, idx: i, mid: false });
      });
      // Midpoints only between real legs; the closing leg of a loop is not a place to insert one.
      for (let i = 0; i + 1 < patrol.legs.length; i++) {
        const a = patrol.legs[i];
        const b = patrol.legs[i + 1];
        pos.push((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        col.push(color.r, color.g, color.b);
        mid.push(1);
        handleMap.push({ ring: 0, idx: i, mid: true });
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
      geo.setAttribute("mid", new THREE.BufferAttribute(new Float32Array(mid), 1));
      handlePoints = new THREE.Points(geo, handleMat);
      handlePoints.renderOrder = 5;
      overlay.add(handlePoints);
    }

    if (activeRegion && !patrol) {
      const outlineColor = colorOf(activeRegion.name);
      // Hole handles take the region's opposite hue, so it is obvious which ring you are dragging.
      const holeColor = new THREE.Color().setHSL((hueOf(activeRegion.name) + 0.5) % 1, 0.9, 0.6);
      const pos: number[] = [];
      const col: number[] = [];
      const mid: number[] = [];
      activeRegion.rings.forEach((ring, ri) => {
        const c = ri === 0 ? outlineColor : holeColor;
        ring.forEach(([x, y, z], vi) => {
          pos.push(x, y, z);
          col.push(c.r, c.g, c.b);
          mid.push(0);
          handleMap.push({ ring: ri, idx: vi, mid: false });
        });
        if (ring.length >= 3) {
          ring.forEach(([x, y, z], vi) => {
            const [nx, ny, nz] = ring[(vi + 1) % ring.length];
            pos.push((x + nx) / 2, (y + ny) / 2, (z + nz) / 2);
            col.push(c.r, c.g, c.b);
            mid.push(1);
            handleMap.push({ ring: ri, idx: vi, mid: true });
          });
        }
      });
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
        geo.setAttribute("mid", new THREE.BufferAttribute(new Float32Array(mid), 1));
        handlePoints = new THREE.Points(geo, handleMat);
        handlePoints.renderOrder = 5;
        overlay.add(handlePoints);
      }
    }
  });

  onMount(() => {
    // The frame callbacks run from the next animation frame on, so they can close over the handlers
    // and materials declared further down this function.
    const viewer = createViewer(canvasElement, {
      scene: scene(),
      camera: camera(),
      onFrame: dt => {
        for (const m of [...activeLineMaterials, stalkMaterial, ...obstacleLineMaterials]) {
          m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        }
        stepReplay(dt);
      },
      onAfterRender: () => placeLabels(),
    });
    controls = viewer.controls;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 2 };
    const mouse = new THREE.Vector2();
    let downAt: { x: number; y: number; } | null = null;
    let rightDownAt: { x: number; y: number; } | null = null;

    const aim = (ev: MouseEvent) => {
      const rect = canvasElement.getBoundingClientRect();
      mouse.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera());
    };

    // Point picking works in world units, so convert the grab radius from pixels at the
    // current zoom — otherwise a fixed radius is unhittable when zoomed out.
    const grabRadius = (pixels: number) => {
      const cam = camera();
      const dist = cam.position.distanceTo(controls!.target);
      const worldPerPixel = (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / canvasElement.clientHeight;
      raycaster.params.Points!.threshold = pixels * worldPerPixel;
    };

    const pickSpawn = (): Spawn | undefined => {
      if (!spawnPoints) return undefined;
      grabRadius(8);
      const hit = raycaster.intersectObject(spawnPoints)[0];
      return hit?.index === undefined ? undefined : props.spawns[drawnSpawns[hit.index]];
    };

    const pickHandle = (): Handle | null => {
      if (!handlePoints) return null;
      grabRadius(12);
      const hit = raycaster.intersectObject(handlePoints)[0];
      return hit?.index !== undefined ? handleMap[hit.index] : null;
    };

    // Zone coordinates under the cursor. Vertices take their height from the terrain here, which
    // is what makes the polygon describe a floor.
    const pickZonePoint = (fallbackY = 0): THREE.Vector3 | null => {
      const hit = zoneMesh && raycaster.intersectObject(zoneMesh, true)[0];
      if (hit) return scene().worldToLocal(hit.point.clone());
      // Scene is flipped on y/z, so a zone plane at h sits at world y = -h.
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), fallbackY);
      const world = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      return world ? scene().worldToLocal(world) : null;
    };

    const lastY = (r?: RegionEntry) => r?.rings.flat().at(-1)?.[1] ?? 0;

    // Where the cursor meets terrain. Only a real mesh hit counts — the plane fallback used for
    // editing would report coordinates for empty space.
    const groundPoint = () => {
      const hit = zoneMesh && raycaster.intersectObject(zoneMesh, true)[0];
      return hit ? scene().worldToLocal(hit.point.clone()) : undefined;
    };

    const removeVertex = (handle: Handle) => {
      if (activePath()) return editPath(legs => legs.splice(handle.idx, 1));
      editActive(r => {
        r.rings[handle.ring].splice(handle.idx, 1);
        if (handle.ring > 0 && r.rings[handle.ring].length < 3) r.rings.splice(handle.ring, 1);
      });
    };

    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      // A right-drag turned the view; letting go of it is not asking for a menu.
      if (rightDownAt && Math.hypot(ev.clientX - rightDownAt.x, ev.clientY - rightDownAt.y) > 3) return;
      // The menu opens where the cursor is, which is where the tooltip already is.
      setHover(null);
      aim(ev);
      const handle = pickHandle();
      if (handle && !handle.mid) {
        checkpoint("remove a vertex");
        return removeVertex(handle); // midpoints are not stored, so there is nothing to remove
      }

      const spawn = pickSpawn();
      if (spawn) return setMenu({ kind: "spawn", spawn, x: ev.clientX, y: ev.clientY });
      const p = pickZonePoint();
      const act = active();
      const hole = p && act && !props.readOnly ? holeAt(act, p.x, p.z) : 0;
      if (hole) return setMenu({ kind: "hole", name: act!.name, index: hole, x: ev.clientX, y: ev.clientY });
      const name = p && regionAt(asSet(regions()), p.x, p.z, p.y);
      setMenu(name ? { kind: "region", name, x: ev.clientX, y: ev.clientY } : null);
    };

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button === 2) rightDownAt = { x: ev.clientX, y: ev.clientY };
      // Reviewing: the camera, hovering and selection all still work; nothing moves under them.
      if (props.readOnly) return;
      if (ev.button !== 0) return;
      downAt = { x: ev.clientX, y: ev.clientY };
      if (ev.altKey) return; // alt is for copying a position, never for dragging something
      aim(ev);
      const handle = pickHandle();

      if (!handle) {
        // Dragging a spawn dot into a polygon assigns it to that region.
        const spawn = pickSpawn();
        if (!spawn) return;
        const start = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
        const geo = new THREE.BufferGeometry().setFromPoints([start, start.clone()]);
        const line = new THREE.Line(geo, materialFor("rubber", () => new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false })));
        line.renderOrder = 6;
        scene().add(line);
        spawnDrag = { spawn, line };
        controls!.enabled = false;
        return;
      }

      checkpoint("add a vertex");
      if (handle.mid && activePath()) {
        const p = pickZonePoint(activePath()!.legs[handle.idx][1]);
        editPath(legs => {
          const a = legs[handle.idx];
          const b = legs[handle.idx + 1];
          legs.splice(handle.idx + 1, 0, p ? [p.x, p.y, p.z] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
        });
        drag = { ring: 0, idx: handle.idx + 1 };
      } else if (handle.mid) {
        const p = pickZonePoint(lastY(active()));
        editActive(r => {
          const ring = r.rings[handle.ring];
          const a = ring[handle.idx];
          const b = ring[(handle.idx + 1) % ring.length];
          const mid: Vertex = p ? [p.x, p.y, p.z] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          ring.splice(handle.idx + 1, 0, mid);
        });
        drag = { ring: handle.ring, idx: handle.idx + 1 };
      } else {
        drag = { ring: handle.ring, idx: handle.idx };
      }
      setHover(null); // otherwise a stale hover keeps overriding the pinned trail mid-drag
      controls!.enabled = false;
      ev.preventDefault();
    };

    const onMouseMove = (ev: MouseEvent) => {
      aim(ev);
      setCursor(groundPoint());
      if (!drag && !spawnDrag && mode() === "select") {
        const act = active();
        const p = act ? pickZonePoint(lastY(act)) : null;
        const k = p && act ? holeAt(act, p.x, p.z) : 0;
        setHoleHover(k && act ? { name: act.name, index: k, x: ev.clientX, y: ev.clientY } : null);
      } else setHoleHover(null);

      if (drag) {
        const p = pickZonePoint(activePath()?.legs[drag.idx]?.[1] ?? lastY(active()));
        if (!p) return;
        if (activePath()) editPath(legs => (legs[drag!.idx] = [p.x, p.y, p.z]));
        else editActive(r => (r.rings[drag!.ring][drag!.idx] = [p.x, p.y, p.z]));
        return;
      }
      if (spawnDrag) {
        const p = pickZonePoint(spawnDrag.spawn.y);
        if (p) {
          const pos = spawnDrag.line.geometry.getAttribute("position") as THREE.BufferAttribute;
          pos.setXYZ(1, p.x, p.y, p.z);
          pos.needsUpdate = true;
        }
        return;
      }
      // And it stays gone until the menu does: nudging the mouse on the way to it would otherwise
      // bring the tooltip straight back on top of it.
      const spawn = menu() ? null : pickSpawn();
      setHover(spawn ? { spawn, x: ev.clientX, y: ev.clientY } : null);
    };

    const endSpawnDrag = (ev: MouseEvent) => {
      if (!spawnDrag) return;
      const { spawn, line } = spawnDrag;
      spawnDrag = null;
      setHover(null);
      scene().remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();

      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) <= 3) return; // a click, not a drag
      aim(ev);
      const p = pickZonePoint(spawn.y);
      const act = active();
      // Only regions you can see can be dropped onto.
      const target = !p ? null : act ? (containsXZ(act, p.x, p.z) ? act.name : null) : regionAt(asSet(regions()), p.x, p.z, spawn.y);
      if (!target) return;
      checkpoint(`assign ${spawn.name} to ${target}`);
      setAssign(a => ({ ...a, [spawn.id]: [target] }));
    };

    const onMouseUp = (ev: MouseEvent) => {
      endSpawnDrag(ev);
      drag = null;
      controls!.enabled = true;
    };

    const onClick = (ev: MouseEvent) => {
      if (props.readOnly && mode() === "draw") return;
      setMenu(null);
      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 3) return;
      aim(ev);

      if (ev.altKey) {
        const p = groundPoint();
        if (p) copy(`!pos ${xyz(p)}`);
        return;
      }
      if (pickHandle()) return;

      if (mode() === "obstacles") {
        const p = pickZonePoint(lastY(active()));
        const o = p && obstacleAt(obstacles(), p.x, p.z, obstacleMargin(), OBSTACLE_CELL);
        if (o) ringObstacles([o]);
        return;
      }

      if (mode() === "draw" && activePath()) {
        const p = pickZonePoint(activePath()!.legs.at(-1)?.[1] ?? 0);
        if (!p) return;
        checkpoint("add a leg");
        editPath(legs => legs.push([p.x, p.y, p.z]));
        return;
      }

      if (mode() === "draw") {
        const r = active();
        const p = pickZonePoint(lastY(r));
        if (!p || !r) return;
        checkpoint("add a vertex");
        editActive(c => c.rings[c.rings.length - 1].push([p.x, p.y, p.z]));
        return;
      }

      // Dots only take the click when there is a region to assign them to; otherwise it falls
      // through to picking a region, so a dot can't block selecting the polygon under it.
      const spawn = pickSpawn();
      const name = activeName();
      if (spawn && name) {
        checkpoint(`assign ${spawn.name}`);
        setAssign(a => {
          const next = { ...a };
          const current = next[spawn.id] ?? [];
          if (current.includes(name)) {
            // Taking the last one away unassigns it, rather than leaving an empty list behind.
            const rest = current.filter(n => n !== name);
            if (rest.length) next[spawn.id] = rest;
            else delete next[spawn.id];
          } else if (ev.shiftKey) {
            // More than one region means the server picks between them on every spawn. Rare
            // enough to be worth a modifier rather than a mode: alt copies a position and
            // ctrl is undo, so shift is what was left.
            next[spawn.id] = [...current, name];
          } else {
            next[spawn.id] = [name];
          }
          return next;
        });
        return;
      }

      // A route owns the handles while it is being edited, so a click that missed them was meant
      // for the map: leave the route, the same way clicking outside a region deselects it.
      if (walker()) {
        editWalker(null);
        return;
      }

      // With one region selected the others are hidden, so only it can be clicked: anywhere else
      // clears the selection and releases a pinned trail. With none selected, any polygon picks up.
      const p = pickZonePoint();
      const act = active();
      if (act) {
        if (!p || !containsXZ(act, p.x, p.z)) {
          setActiveName(null);
          setPinnedId(null);
        }
        return;
      }
      const picked = (p && regionAt(asSet(regions()), p.x, p.z, p.y)) ?? null;
      setActiveName(picked);
      if (picked) zoomTo(picked);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === "INPUT") return;
      if (ev.ctrlKey || ev.metaKey) {
        const key = ev.key.toLowerCase();
        if (key === "z" && !ev.shiftKey) return (ev.preventDefault(), undo());
        if (key === "y" || (key === "z" && ev.shiftKey)) return (ev.preventDefault(), redo());
        return;
      }
      if ((ev.key === "PageDown" || ev.key === "PageUp") && mode() !== "draw") {
        ev.preventDefault();
        return stepRegion(ev.key === "PageDown" ? 1 : -1);
      }
      if (ev.key !== "Escape" && ev.key !== "Enter") return;
      if (mode() !== "draw") {
        // Not drawing, so there is nothing to finish: Escape backs out of whatever is selected.
        if (ev.key !== "Escape") return;
        if (merge()) setMerge(null);
        else if (mode() === "obstacles") setMode("select");
        else if (replayId()) setReplayId(null);
        else if (walker()) editWalker(null);
        else setActiveName(null);
        return;
      }
      const id = walker();
      if (id) {
        // A route of one leg is not a route; drop it rather than leaving a stub behind.
        if ((paths()[id]?.legs.length ?? 0) < 2) dropPath(id);
      } else {
        editActive(r => {
          if (r.rings.length > 1 && r.rings[r.rings.length - 1].length < 3) r.rings.pop();
        });
      }
      setMode("select");
    };

    canvasElement.addEventListener("mousedown", onMouseDown);
    canvasElement.addEventListener("mousemove", onMouseMove);
    canvasElement.addEventListener("mouseup", onMouseUp);
    canvasElement.addEventListener("click", onClick);
    canvasElement.addEventListener("contextmenu", onContextMenu);
    const onAnyClick = (ev: MouseEvent) => {
      if (!menuElement?.contains(ev.target as Node)) setMenu(null);
    };
    window.addEventListener("click", onAnyClick);
    window.addEventListener("keydown", onKeyDown);

    if (spawnPoints) fitCameraToContents(camera(), controls, fn => fn(spawnPoints!));

    const projected = new THREE.Vector3();
    // Scene is flipped on y/z, so zone coordinates negate on the way to world space.
    const place = (el: HTMLDivElement, at: Vertex | null) => {
      if (!at) {
        // Hundreds of these are hidden at any moment, and writing "none" over "none" sixty times a
        // second for each of them is work nobody sees.
        if (el.style.display !== "none") el.style.display = "none";
        return;
      }
      projected.set(at[0], -at[1], -at[2]).project(camera());
      // Behind the camera or off the side of it: no reason to place it, and with a label per mob
      // that is most of them most of the time.
      const onScreen = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      const want = onScreen ? "block" : "none";
      if (el.style.display !== want) el.style.display = want;
      if (!onScreen) return;
      el.style.transform = `translate(-50%, -50%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
        (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight
      }px)`;
    };

    const middle = (points: Vertex[]): Vertex => {
      let x = 0, y = 0, z = 0;
      for (const v of points) (x += v[0], y += v[1], z += v[2]);
      return [x / points.length, y / points.length, z / points.length];
    };

    // Whether the mob labels are currently on screen, so the loop that hides them runs once.
    let spawnLabelsShown = true;

    const placeLabels = () => {
      const only = activeName();
      for (const r of regions()) {
        const el = labelRefs.get(r.name);
        if (!el) continue;
        const ring = r.rings[0] ?? [];
        place(el, ring.length >= 3 && !(only && r.name !== only) && onRegionFloor(r) ? middle(ring) : null);
      }
      // Routes label the mob that walks them, and hide with everything else while a region is picked.
      for (const route of routeGroups()) {
        const el = pathLabelRefs.get(route.lead);
        if (el) place(el, !only && route.legs.length >= 2 ? middle(route.legs) : null);
      }

      // A few hundred mob names at once are unreadable on top of each other and cost a style write
      // each per frame, so they only appear once the view is close enough for them to be worth
      // reading. A region being edited hides them too, the way it hides everything else.
      const cam = camera();
      const perPixel = (2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.distanceTo(controls!.target))
        / canvasElement.clientHeight;
      const readable = !only && !walker() && perPixel < 0.5;
      // Zoomed out, every one of several hundred is hidden and stays hidden. Hiding them once and
      // then leaving the loop alone is the difference between a few hundred projections a frame
      // and none at all.
      if (!readable && !spawnLabelsShown) return;
      spawnLabelsShown = readable;
      for (const s of labelledSpawns()) {
        const el = spawnLabelRefs.get(s.id);
        if (el) place(el, readable && spawnOnFloor(s) ? [s.x, s.y, s.z] : null);
      }
    };

    // The comet: one point per tail sample plus the head, its brightness fading back along the way
    // it came. Positions are rewritten in place each frame rather than rebuilt.
    const cometGeo = new THREE.BufferGeometry();
    cometGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((REPLAY_TAIL + 1) * 3), 3));
    cometGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array((REPLAY_TAIL + 1) * 3), 3));
    cometGeo.setAttribute("big", new THREE.BufferAttribute(new Float32Array(REPLAY_TAIL + 1), 1));
    const comet = new THREE.Points(cometGeo, cometMaterial());
    comet.renderOrder = 6;
    comet.visible = false;
    scene().add(comet, beacon, stalk);
    onCleanup(() => scene().remove(beacon, stalk));
    onCleanup(() => {
      scene().remove(comet);
      cometGeo.dispose();
      (comet.material as THREE.Material).dispose();
    });

    // An arrowhead riding the comet, because a fading tail says where it has been and only an arrow
    // says where it is going. Two barbs swept back from the head, drawn as a line so its thickness
    // is in pixels and it stays visible however far out the camera is.
    const arrowGeo = new LineGeometry();
    arrowGeo.setPositions([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const arrowMaterial = new LineMaterial({ color: 0xffc733, linewidth: 2, depthTest: false, transparent: true });
    const arrow = new Line2(arrowGeo, arrowMaterial);
    arrow.renderOrder = 7;
    arrow.visible = false;
    scene().add(arrow);
    onCleanup(() => {
      scene().remove(arrow);
      arrowGeo.dispose();
      arrowMaterial.dispose();
    });

    let playhead = 0;
    const stepReplay = (dt: number) => {
      const trail = replayTrail();
      comet.visible = arrow.visible = trail.length > 1;
      if (!comet.visible) {
        playhead = 0;
        return;
      }
      playhead = (playhead + dt * REPLAY_RATE * replaySpeed()) % trail.length;
      const head = Math.floor(playhead);
      if (head !== replayAt()) setReplayAt(head);

      // Between one sample and the next the head slides, so it reads as a mob walking rather than a
      // dot blinking from place to place. Not across a break in the capture: there it did jump.
      const from = trail[head];
      const to = trail[(head + 1) % trail.length];
      const step = Math.hypot(to.x - from.x, to.z - from.z);
      const frac = step > 30 ? 0 : playhead - head;
      const hx = from.x + (to.x - from.x) * frac;
      const hy = from.y + (to.y - from.y) * frac;
      const hz = from.z + (to.z - from.z) * frac;

      const pos = cometGeo.getAttribute("position") as THREE.BufferAttribute;
      const col = cometGeo.getAttribute("color") as THREE.BufferAttribute;
      const big = cometGeo.getAttribute("big") as THREE.BufferAttribute;
      pos.setXYZ(0, hx, hy, hz);
      col.setXYZ(0, 1, 0.75, 0.15);
      big.setX(0, 1);
      for (let i = 1; i <= REPLAY_TAIL; i++) {
        const p = trail[(head - i + 1 + trail.length) % trail.length];
        pos.setXYZ(i, p.x, p.y, p.z);
        const fade = 1 - (i - 1) / REPLAY_TAIL;
        col.setXYZ(i, 0.25 + fade * 0.75, fade * fade * 0.6, 0.08); // amber, dropping away to dark red
        big.setX(i, 0);
      }
      pos.needsUpdate = col.needsUpdate = big.needsUpdate = true;

      // Barbs sized in world units from the camera distance, so the arrow keeps its size on screen.
      const cam = camera();
      const perPixel = (2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.distanceTo(controls!.target))
        / canvasElement.clientHeight;
      const len = Math.max(0.2, perPixel * 12); // in world units, but that is 12 pixels at any zoom
      const ahead = trail[(head + (step > 30 ? 2 : 1)) % trail.length];
      const dx = ahead.x - hx;
      const dz = ahead.z - hz;
      const away = Math.hypot(dx, dz) || 1;
      const ux = dx / away;
      const uz = dz / away;
      const barb = (turn: number): [number, number, number] => {
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        return [hx - (ux * c - uz * s) * len, hy, hz - (ux * s + uz * c) * len];
      };
      arrowGeo.setPositions([...barb(0.5), hx, hy, hz, ...barb(-0.5)]);
      arrowMaterial.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
    };

    onCleanup(() => {
      window.removeEventListener("click", onAnyClick);
      window.removeEventListener("keydown", onKeyDown);
      canvasElement.removeEventListener("mousedown", onMouseDown);
      canvasElement.removeEventListener("mousemove", onMouseMove);
      canvasElement.removeEventListener("mouseup", onMouseUp);
      canvasElement.removeEventListener("click", onClick);
      canvasElement.removeEventListener("contextmenu", onContextMenu);
      viewer.dispose();
    });
  });

  const jumpTo = (f: Finding) => {
    if (f.spawnId) {
      const s = props.spawns.find(x => x.id === f.spawnId);
      if (s) flyTo(s.x, s.y, s.z);
      if (f.region && regions().some(r => r.name === f.region)) setActiveName(f.region);
      return;
    }
    if (f.region) centerOn(f.region);
  };

  const vertexCount = (r: RegionEntry) => r.rings[0]?.length ?? 0;

  return (
    <div class="flex gap-4" style={{ height: "78vh" }}>
      <MobList
        spawns={props.spawns}
        assign={assign()}
        paths={paths()}
        samples={id => props.roam?.ranges[id]?.[1] ?? 0}
        colorOf={cssOf}
        activeName={activeName()}
        pinnedId={pinnedId()}
        onHover={setRowFocus}
        onPin={id => setPinnedId(current => (current === id ? null : id))}
        onCentre={s => flyTo(s.x, s.y, s.z)}
        onAssign={(s, add) => {
          checkpoint(`assign ${s.name} to ${activeName()}`);
          setAssign(a => ({
            ...a,
            // Adding is idempotent: naming a region twice would be written out twice.
            [s.id]: add ? [...(a[s.id] ?? []).filter(n => n !== activeName()), activeName()!] : [activeName()!],
          }));
        }}
        onMenu={(spawn, x, y) => setMenu({ kind: "spawn", spawn, x, y })}
        visible={spawnOnFloor}
        onBuildRegion={buildFrom}
        canBuild={!!props.roam}
      />
      <div class="flex-1 relative">
        <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
          <For each={regions()}>
            {r => {
              onCleanup(() => labelRefs.delete(r.name));
              // A DOM element over the canvas, so clicking it beats whatever the raycast would
              // pick. That makes it the reliable way to grab a region buried under another.
              return (
                <div
                  ref={el => labelRefs.set(r.name, el)}
                  class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/75 cursor-pointer hover:bg-slate-900 hover:ring-1 hover:ring-slate-500"
                  // while drawing, the map owns every click: a label here would silently eat one
                  classList={{ "pointer-events-auto": mode() !== "draw", "pointer-events-none": mode() === "draw" }}
                  style={{ color: cssOf(r.name) }}
                  title={`Select ${r.name}, right-click for more`}
                  onClick={() => (setActiveName(r.name), zoomTo(r.name))}
                  onContextMenu={e => (e.preventDefault(), setMenu({ kind: "region", name: r.name, x: e.clientX, y: e.clientY }))}
                >
                  {r.name} <span class="text-slate-400 font-normal">{spawnCounts()[r.name] ?? 0}</span>
                </div>
              );
            }}
          </For>
          <For each={routeGroups()}>
            {group => {
              onCleanup(() => pathLabelRefs.delete(group.lead));
              const spawn = () => props.spawns.find(s => s.id === group.lead);
              return (
                <div
                  ref={el => pathLabelRefs.set(group.lead, el)}
                  class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/75 cursor-pointer hover:bg-slate-900 hover:ring-1 hover:ring-slate-500"
                  classList={{ "pointer-events-auto": mode() !== "draw", "pointer-events-none": mode() === "draw" }}
                  style={{ color: `#${PATH_COLOR.toString(16)}` }}
                  title={`Edit ${spawn()?.name ?? group.lead}'s route, right-click for more`}
                  onClick={() => selectRoute(group.lead)}
                  onContextMenu={e => (e.preventDefault(), setMenu({ kind: "route", lead: group.lead, x: e.clientX, y: e.clientY }))}
                >
                  {spawn()?.name ?? group.lead}
                  <span class="text-slate-400 font-normal">
                    {group.ids.length > 1 ? ` x${group.ids.length}` : ""} {group.legs.length} legs
                  </span>
                </div>
              );
            }}
          </For>
          <For each={labelledSpawns()}>
            {s => {
              onCleanup(() => spawnLabelRefs.delete(s.id));
              // Not clickable: the dot underneath already is, and a few hundred click targets over
              // the map would be in the way of dragging it.
              return (
                <div
                  ref={el => spawnLabelRefs.set(s.id, el)}
                  class="absolute top-0 left-0 mt-3 hidden whitespace-nowrap text-[10px] leading-none text-slate-300 bg-slate-900/60 rounded px-1 py-px pointer-events-none"
                >
                  {s.name}
                </div>
              );
            }}
          </For>
        </div>
        {/* What is being edited and how to stop — the full list of keys lives in the shortcuts card. */}
        <Show when={walker() || activeName() || pinnedSpawn() || replayId()}>
          <div class="absolute top-2 left-1/2 -translate-x-1/2 text-xs text-slate-200 bg-slate-900/85 rounded px-3 py-1.5 pointer-events-none text-center">
            <Show when={walkerSpawn()}>
              {spawn => (
                <div>
                  Editing patrol for <b style={{ color: `#${PATH_COLOR.toString(16)}` }}>{spawn().name}</b> <span class="text-slate-400">{spawn().id}</span>
                  <Show when={mirror().length}>
                    <span class="text-slate-400">{` and ${mirror().length} more`}</span>
                  </Show>
                  <span class="text-slate-400">{mode() === "draw" ? " · click to add legs, Enter when done" : " · Esc to exit"}</span>
                </div>
              )}
            </Show>
            <Show when={!walker() && activeName()}>
              {name => (
                <div>
                  Editing region <b style={{ color: cssOf(name()) }}>{name()}</b> <span class="text-slate-400">{`(${mobs(spawnCounts()[name()] ?? 0)})`}</span>
                  <span class="text-slate-400">{mode() === "draw" ? " · click to add vertices, Enter when done" : " · Esc to exit"}</span>
                </div>
              )}
            </Show>
            <Show when={pinnedSpawn()}>
              <div>
                holding <b>{pinnedSpawn()!.name}</b> <span class="text-slate-400">{pinnedSpawn()!.id}</span>, click it again to release
              </div>
            </Show>
            <Show when={replaySpawn()}>
              {spawn => (
                <div>
                  Replaying <b style={{ color: "#fbbf24" }}>{spawn().name}</b>{" "}
                  <span class="text-slate-400">
                    {replayAt()} of {replayTrail().length} points{replayClock() ? `, ${replayClock()}` : ""}
                  </span>{" "}
                  {/* The banner ignores clicks, so the one control on it has to ask for them back. */}
                  <button
                    class="pointer-events-auto px-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                    title="Playback speed"
                    onClick={() => setReplaySpeed(SPEEDS[(SPEEDS.indexOf(replaySpeed()) + 1) % SPEEDS.length])}
                  >
                    {replaySpeed()}x
                  </button>{" "}
                  <span class="text-slate-400">· Esc to stop</span>
                </div>
              )}
            </Show>
          </div>
        </Show>
        <ShortcutsCard />
        {/* The map's own toolbar: tools that act on the view rather than the lists beside it. */}
        <Show when={!props.readOnly}>
          <div class="absolute top-2 left-2 flex gap-1 text-xs">
            <button
              class="flex items-center gap-1.5 px-2 py-1 rounded disabled:opacity-40"
              classList={{
                "bg-amber-600 hover:bg-amber-500 text-white": mode() === "obstacles",
                "bg-slate-900/80 hover:bg-slate-800 text-slate-200": mode() !== "obstacles",
              }}
              disabled={!active()}
              title={active()
                ? "Carve holes around the collision obstacles in the selected region: trees, rocks, walls"
                : "Select a region first"}
              onClick={() => setMode(m => (m === "obstacles" ? "select" : "obstacles"))}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
                <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
              </svg>
              Carve holes
            </button>
            <button
              class="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900/80 hover:bg-slate-800 text-slate-200 disabled:opacity-40"
              disabled={!active()}
              title={active() ? "Drop the least important quarter of the selected region's vertices" : "Select a region first"}
              onClick={() => {
                checkpoint(`simplify ${activeName()}`);
                editActive(r => (r.rings = r.rings.map(ring => simplifyRing(ring, Infinity, Math.ceil(ring.length * 0.75)))));
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M2 12l3-6 3 4 2-3 4 5" />
                <path d="M2 12h12" stroke-dasharray="2 1.5" />
              </svg>
              Simplify
            </button>
          </div>
        </Show>
        <Show when={mergePlan()}>
          {plan => (
            <div class="absolute top-10 right-2 w-64 text-xs bg-slate-900/90 rounded px-3 py-2 space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-[10px] uppercase tracking-wide text-slate-500">Merge holes</span>
                <span class="text-slate-400">{plan().group.length} in the group · esc cancels</span>
              </div>
              <label class="flex items-center gap-2" title="A hole whose edge is within this of the chosen one joins the merge">
                <span class="w-24 text-slate-300">reach</span>
                <input
                  type="range"
                  class="flex-1"
                  min="0.25"
                  max="12"
                  step="0.25"
                  value={mergeReach()}
                  onInput={e => setMergeReach(Number(e.currentTarget.value))}
                />
                <span class="w-12 text-right font-mono text-slate-200">{mergeReach()}y</span>
              </label>
              <div class="flex gap-1">
                <button
                  class="flex-1 px-2 py-1 bg-violet-700 hover:bg-violet-600 rounded disabled:opacity-40"
                  disabled={plan().group.length < 2}
                  onClick={mergeHoles}
                >
                  Merge {plan().group.length} holes
                </button>
                <button class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded" onClick={() => setMerge(null)}>Cancel</button>
              </div>
            </div>
          )}
        </Show>
        <Show when={mode() === "obstacles" && !props.readOnly && !merge()}>
          <div class="absolute top-10 right-2 w-64 text-xs bg-slate-900/90 rounded px-3 py-2 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[10px] uppercase tracking-wide text-slate-500">Carve holes</span>
              <span class="text-slate-400">
                {obstacles().length} found · {obstacles().length - bulk().length} over the ring-all size · esc leaves
              </span>
            </div>
            <For
              each={[
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
                  unit: "y",
                  get: obstacleJoin,
                  set: setObstacleJoin,
                  min: 0,
                  max: 4,
                  step: 0.25,
                  title: "Faces this close are one obstacle: a trunk and its branches, a rock and its ledges",
                },
                {
                  label: "at least tall",
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
              ]}
            >
              {d => (
                <label class="flex items-center gap-2" title={d.title}>
                  <span class="w-24 text-slate-300">{d.label}</span>
                  <input
                    type="range"
                    class="flex-1"
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    value={d.get()}
                    onInput={e => d.set(Number(e.currentTarget.value))}
                  />
                  <span class="w-12 text-right font-mono text-slate-200">{d.get()}{d.unit}</span>
                </label>
              )}
            </For>
            <div class="flex gap-1">
              <button
                class="flex-1 px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded disabled:opacity-40"
                disabled={!bulk().length}
                title="Ring every obstacle up to the size above; each one goes through the clipper on its own"
                onClick={() => ringObstacles(bulk())}
              >
                Ring all ({bulk().length})
              </button>
              <button
                class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded"
                title="Put every dial back to its default"
                onClick={resetObstacleDials}
              >
                Defaults
              </button>
            </div>
          </div>
        </Show>
        <Show when={cursor()}>
          <div
            class="absolute bottom-2 left-2 font-mono text-xs text-slate-200 bg-slate-900/75 rounded px-2 py-1 cursor-pointer select-none"
            title="Ground position under the cursor. Click to copy, or alt+click the map for !pos"
            onClick={() => copy(xyz(cursor()!))}
          >
            {xyz(cursor()!)}
          </div>
        </Show>
        <Show when={menu()}>
          <div
            ref={menuElement}
            class="fixed z-50 min-w-44 bg-slate-900 border border-slate-600 rounded shadow-lg py-1 text-xs"
            style={{ left: `${menu()!.x}px`, top: `${menu()!.y}px` }}
          >
            <Show when={menu()!.kind === "region" ? (menu() as any).name : null}>
              {name => (
                <>
                  <div class="px-3 py-1 text-slate-500">{name()}</div>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                    onClick={() => (convertToPatrol(name()), setMenu(null))}
                  >
                    Convert to patrol ({mobs(props.spawns.filter(s => assign()[s.id] === name()).length)})
                  </button>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700" onClick={() => (repairShape(name()), setMenu(null))}>
                    Repair the shape
                  </button>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700" onClick={() => (centerOn(name()), setMenu(null))}>
                    Centre on it
                  </button>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700 text-red-400" onClick={() => (deleteRegion(name()), setMenu(null))}>
                    Delete region
                  </button>
                </>
              )}
            </Show>
            <Show when={menu()!.kind === "hole" ? (menu() as any) as { name: string; index: number; } : null}>
              {hole => (
                <>
                  <div class="px-3 py-1 text-slate-500">
                    {hole().name} · hole {hole().index} · {Math.abs(ringArea(active()?.rings[hole().index] ?? [])).toFixed(0)} y²
                  </div>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                    onClick={() => (setMerge({ name: hole().name, index: hole().index }), setMenu(null))}
                  >
                    Merge nearby holes… ({active() ? nearHoles(active()!, hole().index, mergeReach()).length : 0} within {mergeReach()}y)
                  </button>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700 text-red-400"
                    onClick={() => (deleteHole(hole().name, hole().index), setMenu(null))}
                  >
                    Delete hole
                  </button>
                </>
              )}
            </Show>
            <Show when={menu()!.kind === "spawn" ? (menu() as any).spawn as Spawn : null}>
              {spawn => (
                <>
                  <div class="px-3 py-1 text-slate-500">{spawn().name} {spawn().id}</div>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                    onClick={() => (startPath(spawn()), setMenu(null))}
                  >
                    Trace a patrol route
                  </button>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                    onClick={() => {
                      setMenu(null);
                      if (replayId() === spawn().id) return setReplayId(null);
                      if (trailPoints([spawn().id]).length < 2) return flash(`no roam trail for ${spawn().name}`);
                      setReplayId(spawn().id);
                    }}
                  >
                    {replayId() === spawn().id ? "Stop the replay" : "Replay its trail"}
                  </button>
                  <Show when={activeName()}>
                    <button
                      class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                      onClick={() => {
                        checkpoint(`assign ${spawn().name} to ${activeName()}`);
                        setAssign(a => ({ ...a, [spawn().id]: [activeName()!] }));
                        setMenu(null);
                      }}
                    >
                      Assign to {activeName()}
                    </button>
                  </Show>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700" onClick={() => (flyTo(spawn().x, spawn().y, spawn().z), setMenu(null))}>
                    Centre on it
                  </button>
                </>
              )}
            </Show>
            <Show when={menu()!.kind === "route" ? routeGroups().find(g => g.lead === (menu() as any).lead) : null}>
              {group => (
                <>
                  <div class="px-3 py-1 text-slate-500">
                    {props.spawns.find(s => s.id === group().lead)?.name ?? group().lead}
                    {group().ids.length > 1 ? ` and ${group().ids.length - 1} more` : ""}
                  </div>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700" onClick={() => (selectRoute(group().lead), setMenu(null))}>
                    Edit the legs
                  </button>
                  <button class="block w-full text-left px-3 py-1 hover:bg-slate-700" onClick={() => (retrace(group().lead), setMenu(null))}>
                    Re-trace from the roam trail
                  </button>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700"
                    onClick={() => (setReplayId(replayId() === group().lead ? null : group().lead), setMenu(null))}
                  >
                    {replayId() === group().lead ? "Stop the replay" : "Replay the trail it came from"}
                  </button>
                  <button
                    class="block w-full text-left px-3 py-1 hover:bg-slate-700 text-red-400"
                    onClick={() => {
                      // Read the group before dropping it: the accessor is gone the moment the
                      // routes it was built from are, and reading it then throws.
                      const ids = [...group().ids];
                      checkpoint(`drop the route for ${mobs(ids.length)}`);
                      setPaths(all => {
                        const next = { ...all };
                        for (const id of ids) delete next[id];
                        return next;
                      });
                      if (ids.includes(walker() ?? "")) editWalker(null);
                      flash(`dropped the route for ${mobs(ids.length)}`);
                      setMenu(null);
                    }}
                  >
                    Drop the route
                  </button>
                </>
              )}
            </Show>
          </div>
        </Show>
        <Show when={toast()}>
          <div class="absolute bottom-2 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs font-mono rounded px-3 py-1 pointer-events-none">
            {toast()}
          </div>
        </Show>
        <Show when={holeHover() && !hover() && !menu()}>
          <div
            class="fixed bg-slate-900/90 text-white px-2 py-1 rounded text-xs pointer-events-none z-50"
            style={{ left: `${holeHover()!.x + 12}px`, top: `${holeHover()!.y + 12}px` }}
          >
            <div class="font-bold">hole {holeHover()!.index}</div>
            <div class="text-slate-400">
              {Math.abs(ringArea(active()?.rings[holeHover()!.index] ?? [])).toFixed(0)} y² · {active()?.rings[holeHover()!.index]?.length ?? 0} vertices
            </div>
            <div class="text-slate-500">right-click to delete or merge</div>
          </div>
        </Show>
        <Show when={hover()}>
          <div
            class="fixed bg-slate-900 text-white px-2 py-1 rounded text-xs pointer-events-none z-50"
            style={{ left: `${hover()!.x + 12}px`, top: `${hover()!.y + 12}px` }}
          >
            <div class="font-bold">{hover()!.spawn.name}</div>
            <div class="text-slate-400">{hover()!.spawn.id}</div>
            <div class="text-slate-400">
              {hover()!.spawn.x.toFixed(1)}, {hover()!.spawn.y.toFixed(1)}, {hover()!.spawn.z.toFixed(1)}
            </div>
            {/* A fixed point is not necessarily an oversight: plenty of mobs are meant to stand still. */}
            <div style={{ color: assign()[hover()!.spawn.id]?.length ? cssOf(assign()[hover()!.spawn.id][0]) : "#888" }}>
              {/* "or", not "and": the server picks one of them each time the mob spawns. */}
              {assign()[hover()!.spawn.id]?.join(" or ")
                ?? (paths()[hover()!.spawn.id] ? "walks a route" : "unassigned or static")}
            </div>
            <Show when={props.roam?.ranges[hover()!.spawn.id]}>
              <div class="text-slate-400">{props.roam!.ranges[hover()!.spawn.id][1]} roam points</div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="w-80 flex flex-col bg-slate-800 rounded-lg p-2 overflow-hidden text-sm">
        <div class="flex gap-1 mb-2">
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "regions", "bg-slate-700 text-slate-400": tab() !== "regions" }}
            onClick={() => setTab("regions")}
          >
            Regions ({regions().length})
          </button>
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "paths", "bg-slate-700 text-slate-400": tab() !== "paths" }}
            onClick={() => setTab("paths")}
          >
            Routes ({Object.keys(paths()).length})
          </button>
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "review", "bg-slate-700 text-slate-400": tab() !== "review" }}
            title="Checks every region and how well each covers its mobs' trails. Runs while this tab is open; ? means the regions have changed since the last check."
            onClick={() => setTab("review")}
          >
            Review ({reviewStale() ? "?" : findings().filter(f => f.level !== "info").length})
          </button>
          <button
            class="flex-1 px-2 py-1 rounded"
            classList={{ "bg-slate-600": tab() === "history", "bg-slate-700 text-slate-400": tab() !== "history" }}
            onClick={() => setTab("history")}
          >
            History ({undoStack().length})
          </button>
        </div>

        <Show when={tab() === "history"}>
          <div class="flex gap-2 mb-2">
            <button
              class="flex-1 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:hover:bg-slate-700"
              disabled={!undoStack().length}
              onClick={undo}
            >
              Undo
            </button>
            <button
              class="flex-1 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:hover:bg-slate-700"
              disabled={!redoStack().length}
              onClick={redo}
            >
              Redo
            </button>
          </div>
          <div class="flex-1 overflow-y-auto text-xs">
            {/* Newest first, and clicking one takes the zone back to just before it ran. */}
            <For each={[...redoStack()].reverse()}>
              {step => <div class="py-0.5 px-1 text-slate-600 italic">{step.label}</div>}
            </For>
            <For
              each={[...undoStack()].reverse()}
              fallback={<div class="text-slate-500 p-2">Nothing changed yet.</div>}
            >
              {(step, i) => (
                <div
                  class="py-0.5 px-1 rounded cursor-pointer hover:bg-slate-700 text-slate-300"
                  title="Take the zone back to just before this"
                  onClick={() => rewindTo(undoStack().length - 1 - i())}
                >
                  {step.label}
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={tab() === "paths"}>
          <div class="text-xs text-slate-400 mb-2">
            {/* What is being edited is on the banner over the map, where the editing happens. */}
            <Show when={!walker()}>a route replaces a mob's spawn point, so it walks its legs instead</Show>
          </div>
          <div class="flex-1 overflow-y-auto">
            <For each={Object.entries(paths())} fallback={<div class="text-slate-500 p-2">No patrol routes yet.</div>}>
              {([id, patrol]) => {
                const spawn = () => props.spawns.find(s => s.id === id);
                return (
                  <div
                    ref={el => rowRefs.set(id, el)}
                    class="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-slate-700 text-xs"
                    classList={{ "bg-slate-700": id === walker() }}
                    onContextMenu={e => (
                      e.preventDefault(), setMenu({ kind: "route", lead: routeGroups().find(g => g.ids.includes(id))?.lead ?? id, x: e.clientX, y: e.clientY })
                    )}
                    onClick={() => selectRoute(id)}
                  >
                    <span class="flex-1 truncate" title={spawn()?.name}>{spawn()?.name ?? "unknown"}</span>
                    <span class="text-slate-500">{id}</span>
                    <span class="text-slate-400">{patrol.legs.length} legs</span>
                    <button
                      class="px-1 text-slate-400 hover:text-white"
                      title={patrol.loop === false ? "path: walks back along the same legs" : "circuit: closes into a loop"}
                      onClick={e => {
                        e.stopPropagation();
                        checkpoint(`${props.spawns.find(s => s.id === id)?.name ?? id} walks back and forth`);
                        setPaths(all => ({ ...all, [id]: { ...all[id], loop: all[id].loop === false ? undefined : false } }));
                      }}
                    >
                      {patrol.loop === false ? "↔" : "↻"}
                    </button>
                    <button
                      class="px-1 text-slate-400 hover:text-white"
                      title="Re-trace from the mob's roam trail"
                      onClick={e => (e.stopPropagation(), retrace(id))}
                    >
                      ⟳
                    </button>
                    <button
                      class="px-1 text-slate-400 hover:text-white"
                      title="Add more legs"
                      onClick={e => (e.stopPropagation(), selectRoute(id), setMode("draw"))}
                    >
                      ✎
                    </button>
                    <button class="text-slate-400 hover:text-red-400" title="Remove the route" onClick={e => (e.stopPropagation(), dropPath(id))}>
                      ✕
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={tab() === "review"}>
          <ReviewList findings={findings()} onJump={jumpTo} onRepair={repairShape} />
        </Show>

        <Show when={tab() === "regions"}>
          {
            /* The tools that change geometry, and only those: the list of regions below is the
              main thing a reviewer came to read. */
          }
          <Show when={!props.readOnly}>
            <div class="flex gap-1 mb-2">
              <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={addRegion}>+ Region</button>
              <button
                class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded disabled:opacity-40 disabled:text-slate-300"
                disabled={!active()}
                onClick={() => {
                  checkpoint("start a hole");
                  editActive(r => r.rings.push([]));
                  setMode("draw");
                }}
                title="Cut a hole in the active region"
              >
                + Hole
              </button>
              <button
                class="px-2 py-1 rounded disabled:opacity-40 disabled:text-slate-300"
                classList={{ "bg-emerald-600 hover:bg-emerald-500": mode() === "draw", "bg-slate-600 hover:bg-slate-500": mode() !== "draw" }}
                disabled={!active()}
                onClick={() => setMode(m => (m === "draw" ? "select" : "draw"))}
              >
                {mode() === "draw" ? "Done" : "Draw"}
              </button>
            </div>
          </Show>

          {/* Only somewhere with floors to choose between: an outdoor zone is one map sheet. */}
          <Show when={floors().length > 1}>
            <div class="flex flex-wrap items-center gap-1 mb-2 text-xs">
              <span class="text-slate-400 mr-1">Floor</span>
              <button
                class="px-1.5 py-0.5 rounded"
                classList={{ "bg-slate-600 text-white": floor() === null, "bg-slate-700 text-slate-400": floor() !== null }}
                onClick={() => setFloor(null)}
              >
                All
              </button>
              <For each={floors()}>
                {id => (
                  <button
                    class="px-1.5 py-0.5 rounded"
                    classList={{ "bg-slate-600 text-white": floor() === id, "bg-slate-700 text-slate-400": floor() !== id }}
                    title={`Show only map ${id}, hiding the floors above and below it`}
                    onClick={() => setFloor(floor() === id ? null : id)}
                  >
                    {id}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <label class="flex items-center gap-2 mb-1 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={hideAssigned()} onChange={e => setHideAssigned(e.currentTarget.checked)} />
            hide assigned spawns ({props.spawns.length - Object.keys(assign()).length} left)
          </label>
          <label class="flex items-center gap-2 mb-2 text-xs text-slate-400 cursor-pointer">
            <input type="checkbox" checked={terrainColors()} onChange={e => setTerrainColors(e.currentTarget.checked)} />
            terrain materials
          </label>

          <div class="flex-1 overflow-y-auto">
            <For each={regions().filter(onRegionFloor)} fallback={<div class="text-slate-500 p-2">No regions yet.</div>}>
              {r => (
                <div
                  ref={el => rowRefs.set(r.name, el)}
                  class="flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-slate-700"
                  classList={{ "bg-slate-700": r.name === activeName() }}
                  onClick={() => (setActiveName(r.name), zoomTo(r.name))}
                  onContextMenu={e => (e.preventDefault(), setMenu({ kind: "region", name: r.name, x: e.clientX, y: e.clientY }))}
                >
                  <span class="w-3 h-3 rounded-full shrink-0" style={{ background: cssOf(r.name) }} />
                  <input
                    type="text"
                    class="flex-1 min-w-0 bg-transparent px-1 rounded outline-none hover:bg-slate-600 focus:bg-slate-900"
                    value={r.name}
                    title="Click to rename"
                    onClick={e => e.stopPropagation()}
                    onFocus={() => setActiveName(r.name)}
                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                    onChange={e => {
                      if (!renameRegion(r.name, e.currentTarget.value)) e.currentTarget.value = r.name;
                    }}
                  />
                  <span
                    class="text-xs text-slate-400"
                    title={`${vertexCount(r)} vertices${r.rings.length > 1 ? `, ${r.rings.length - 1} hole${r.rings.length > 2 ? "s" : ""}` : ""}, ${
                      spawnCounts()[r.name] ?? 0
                    } mobs placed here`}
                  >
                    {vertexCount(r)}v{r.rings.length > 1 ? `+${r.rings.length - 1}h` : ""} · {spawnCounts()[r.name] ?? 0}
                  </span>
                  <Show when={coverage()[r.name] !== undefined}>
                    <span
                      class="text-xs"
                      classList={{
                        "text-slate-500": coverage()[r.name] >= 0.9,
                        "text-amber-400": coverage()[r.name] < 0.9 && coverage()[r.name] >= 0.7,
                        "text-red-400": coverage()[r.name] < 0.7,
                      }}
                      title="Share of its mobs' roam points that fall inside this polygon"
                    >
                      {(coverage()[r.name] * 100).toFixed(0)}%
                    </span>
                  </Show>
                  <button class="px-1 text-slate-400 hover:text-white" title="Center" onClick={e => (e.stopPropagation(), centerOn(r.name))}>⌖</button>
                  <button class="text-slate-400 hover:text-red-400" onClick={e => (e.stopPropagation(), deleteRegion(r.name))}>✕</button>
                </div>
              )}
            </For>
          </div>

          <Show when={active()}>
            <div class="border-t border-slate-700 mt-2 pt-2 space-y-2">
              <input
                type="text"
                placeholder="Filter spawns (template or id)..."
                class="w-full px-2 py-1 bg-slate-700 rounded"
                value={filter()}
                onInput={e => setFilter(e.currentTarget.value)}
              />
              <div class="flex gap-1">
                <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs" onClick={() => assignInside(false)}>
                  Assign inside
                </button>
                <button class="flex-1 px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs" onClick={() => assignInside(true)}>
                  Unassign inside
                </button>
                <button
                  class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs disabled:opacity-40 disabled:text-slate-300"
                  disabled={!props.roam}
                  title="Reshape this region around the roam trails of the mobs in it"
                  onClick={refitActive}
                >
                  Refit
                </button>
              </div>

              <div class="text-xs text-slate-400">
                {spawnCounts()[active()!.name] ?? 0} assigned{filter() && ` · ${members().length} shown`}
              </div>
              <div class="max-h-48 overflow-y-auto">
                <For each={members()} fallback={<div class="text-xs text-slate-500 px-1">Nothing assigned yet.</div>}>
                  {s => (
                    <div
                      class="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-slate-700 text-xs cursor-pointer"
                      classList={{ "bg-slate-600 hover:bg-slate-600": s.id === pinnedId() }}
                      title="Click to keep this mob's roam trail on screen"
                      onMouseEnter={() => setRowFocus(s.id)}
                      onMouseLeave={() => setRowFocus(null)}
                      onClick={() => setPinnedId(id => (id === s.id ? null : s.id))}
                    >
                      <span class="flex-1 truncate" title={s.name}>{s.name}</span>
                      <span class="text-slate-500">{s.id}</span>
                      <Show when={s.at} fallback={<span class="px-1 text-slate-600" title="Placed by the region, no fixed point">·</span>}>
                        <button class="px-1 text-slate-400 hover:text-white" title="Center" onClick={() => flyTo(s.x, s.y, s.z)}>⌖</button>
                      </Show>
                      <button class="text-slate-400 hover:text-red-400" title="Unassign" onClick={() => unassign(s.id)}>✕</button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function ReviewList(props: { findings: Finding[]; onJump: (f: Finding) => void; onRepair: (region: string) => void; }) {
  const color = { error: "text-red-400", warn: "text-amber-400", info: "text-slate-400" };
  return (
    <div class="flex-1 overflow-y-auto">
      <For each={props.findings} fallback={<div class="text-emerald-500 p-2">Nothing to flag.</div>}>
        {f => (
          <div class="flex items-center gap-1 py-1 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs" onClick={() => props.onJump(f)}>
            <span class={color[f.level]}>●</span>
            <span class="flex-1 text-slate-300">
              {f.text}
              <Show when={f.region && !f.spawnId}>
                <span class="text-slate-500">{" "}in {f.region}</span>
              </Show>
            </span>
            {/* A crossing ring is the one finding here with a mechanical answer. */}
            <Show when={f.region && /crosses itself/.test(f.text)}>
              <button
                class="px-1.5 rounded bg-slate-600 hover:bg-slate-500 text-slate-100"
                title="Rebuild it as valid shapes"
                onClick={e => (e.stopPropagation(), props.onRepair(f.region!))}
              >
                Repair
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
