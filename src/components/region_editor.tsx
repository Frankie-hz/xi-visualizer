import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import * as THREE from "three";
import { Line2, LineGeometry, LineMaterial, LineSegments2, LineSegmentsGeometry, MapControls } from "three/examples/jsm/Addons.js";
import { convexHull, inRing, mostlyInside, ringDistance, signedArea, withinRing } from "../geometry";
import { createMapCamera, fitCameraToContents } from "../graphics/camera";
import { buildFloorIndex, type FloorIndex } from "../graphics/floors";
import { beaconMaterial, cometMaterial, handleMaterial, roamMaterial, spawnMaterial } from "../graphics/region_points";
import { addNavMesh, addZoneMesh, fillRef, paintOnce, worldPerPixel } from "../graphics/region_scene";
import { setupBaseScene } from "../graphics/scene";
import { createViewer } from "../graphics/viewer";
import { ColorKind, colorMesh, prepareMeshData } from "../graphics/ximesh";
import {
  cellKey,
  cellOf,
  elongation,
  emptyPatches,
  findObstacles,
  floodPatch,
  groundNear,
  keyOfCell,
  obstacleArea,
  obstacleAt,
  ringsAround,
  traceCells,
} from "../obstacles";
import type { Obstacle } from "../obstacles";
import {
  containsXZ,
  regionAt,
  regionHue,
  regionIntersection,
  regionsFromPoints,
  repairRegion,
  routeFromTrail,
  selfIntersects,
  simplifyRing,
  validate,
} from "../regions";
import type { Finding, Patrol, Region, RegionSet, Ring, Spawn, TrailPoint, Vertex } from "../regions";
import type { RoamData } from "../roam";
import { putOnGround } from "../terrain";
import { COLORS, css } from "../theme";
import type { ZoneData } from "../types";
import { copyText, isTyping } from "../util";
import { CarvePanel, PlanPanel } from "./carve_panels";
import { type DialSpec } from "./dial";
import { createHistory } from "./history";
import HistoryTab from "./history_tab";
import { CursorReadout, CursorTooltip, xyz } from "./map_overlays";
import MapToolbar from "./map_toolbar";
import MobList from "./region_mob_list";
import ShortcutsCard from "./region_shortcuts";
import RegionsTab from "./regions_tab";
import ReviewList from "./review_list";
import RoutesTab from "./routes_tab";

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

interface GrowPlan {
  name: string;
  x: number;
  z: number;
  y: number;
}
interface MergePlan {
  name: string;
  index: number;
}
/**
 * What the map is doing with a click. One of these at a time: kept as separate flags they could all
 * be set at once, and a click then did whichever branch came first, under a panel that belonged to
 * another. A grow or merge plan remembers the tool it was opened from, to go back to.
 */
type Tool =
  | { kind: "select"; }
  | { kind: "draw"; /** Which ring of the active region a click adds to; routes ignore it. */ ring: number; }
  | { kind: "carve"; }
  | { kind: "grow"; plan: GrowPlan; back: "select" | "carve"; }
  | { kind: "merge"; plan: MergePlan; back: "select" | "carve"; };
/** Grid the collision mesh's steep faces are read on, in yalms. */
const OBSTACLE_CELL = 0.5;

/** Where every carving dial starts, and where Defaults puts it back. Distances in yalms. */
const OBSTACLE_DEFAULTS = {
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

const GOLDEN = 0.61803398875; // successive regions land far apart on the colour wheel
const PATH_COLOR = COLORS.route;

export default function RegionEditor(props: RegionEditorProps) {
  let canvasElement!: HTMLCanvasElement;
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
  const [tool, setTool] = createSignal<Tool>({ kind: "select" });
  /** The click mode, as the handlers read it. A plan keeps the mode it was opened from. */
  const mode = (): Mode => {
    const t = tool();
    if (t.kind === "draw") return "draw";
    if (t.kind === "carve") return "obstacles";
    if (t.kind === "select") return "select";
    return t.back === "carve" ? "obstacles" : "select";
  };
  const setMode = (next: Mode | ((now: Mode) => Mode)) => {
    const m = typeof next === "function" ? next(mode()) : next;
    setTool(m === "draw" ? { kind: "draw", ring: 0 } : m === "obstacles" ? { kind: "carve" } : { kind: "select" });
  };
  const planBack = () => (mode() === "obstacles" ? "carve" : "select") as "select" | "carve";
  const grow = () => {
    const t = tool();
    return t.kind === "grow" ? t.plan : null;
  };
  /** Opens a grow plan, or closes the one open and goes back to where it was opened from. */
  const setGrow = (plan: GrowPlan | null) => {
    const t = tool();
    if (plan) setTool({ kind: "grow", plan, back: planBack() });
    else if (t.kind === "grow") setTool({ kind: t.back });
  };
  const merge = () => {
    const t = tool();
    return t.kind === "merge" ? t.plan : null;
  };
  const setMerge = (plan: MergePlan | null) => {
    const t = tool();
    if (plan) setTool({ kind: "merge", plan, back: planBack() });
    else if (t.kind === "merge") setTool({ kind: t.back });
  };
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
  /** Index of the hole ring of `r` that holds x/z, the smallest if they nest, or 0 for none. */
  const holeAt = (r: Region, x: number, z: number) => {
    let best = 0;
    let area = Infinity;
    for (let k = 1; k < r.rings.length; k++) {
      if (r.rings[k].length < 3 || !inRing(r.rings[k], x, z)) continue;
      const a = Math.abs(signedArea(r.rings[k]));
      if (a < area) (area = a, best = k);
    }
    return best;
  };
  /** Holes of the active region within `reach` yalms of hole `index`, itself excluded. */
  const nearHoles = (r: Region, index: number, reach = 2) =>
    r.rings.map((ring, k) => k).filter(k => k >= 1 && k !== index && r.rings[k].length >= 3 && ringDistance(r.rings[index], r.rings[k]) <= reach);
  /** A height to build a ring at near a spot: the nearest vertex of the region. */
  const lastYOf = (name: string, x: number, z: number) => {
    const entry = regions().find(r => r.name === name);
    let best = 0, near = Infinity;
    for (const [vx, vy, vz] of entry?.rings.flat() ?? []) {
      const d = (vx - x) ** 2 + (vz - z) ** 2;
      if (d < near) (near = d, best = vy);
    }
    return best;
  };
  /**
   * Deletes the hole under the cursor, along with any hole nested inside it or lying on top of
   * it: earlier tools could leave a ring twice or one inside another, and deleting one of those
   * left the other showing as if nothing had happened.
   */
  const deleteHole = (name: string, index: number) => {
    const entry = regions().find(r => r.name === name);
    const target = entry?.rings[index];
    if (!entry || !target) return;
    const gone = new Set([index]);
    for (let k = 1; k < entry.rings.length; k++) {
      const ring = entry.rings[k];
      if (k !== index && ring.length >= 3 && ring.every(([x, , z]) => inRing(target, x, z) || target.some(v => v[0] === x && v[2] === z))) gone.add(k);
    }
    checkpoint(gone.size === 1 ? "delete a hole" : `delete ${gone.size} holes`);
    setRegions(rs => rs.map(r => (r.name === name ? { name, rings: r.rings.filter((_, k) => !gone.has(k)) } : r)));
    setHoleHover(null);
    const left = entry.rings.length - 1 - gone.size;
    flash(gone.size > 1 ? `deleted the hole and ${gone.size - 1} nested in it, ${left} left` : `deleted hole ${index}, ${left} left`);
  };
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
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [toast, setToast] = createSignal<{ text: string; warn: boolean; } | undefined>();
  const [rowFocus, setRowFocus] = createSignal<string | null>(null);
  const [pinnedId, setPinnedId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<
    | { x: number; y: number; }
      & (
        | { kind: "region"; name: string; }
        | { kind: "hole"; name: string; index: number; }
        | { kind: "ground"; name: string; x0: number; z0: number; }
        | { kind: "spawn"; spawn: Spawn; }
        | { kind: "route"; lead: string; }
      )
    | null
  >(null);

  // The menu opens at the cursor, which near the right or bottom edge put half of it off screen.
  // Pulled back inside once it has a size, and focused so the keyboard can reach it.
  createEffect(() => {
    if (!menu()) return;
    requestAnimationFrame(() => {
      const el = menuElement;
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (box.right > innerWidth - 4) el.style.left = `${Math.max(4, innerWidth - box.width - 4)}px`;
      if (box.bottom > innerHeight - 4) el.style.top = `${Math.max(4, innerHeight - box.height - 4)}px`;
      el.querySelector("button")?.focus({ preventScroll: true });
    });
  });

  type Menu = NonNullable<ReturnType<typeof menu>>;
  /** The open menu, if it is of this kind, typed as that kind. */
  const menuAs = <K extends Menu["kind"]>(kind: K) => {
    const m = menu();
    return m?.kind === kind ? (m as Extract<Menu, { kind: K; }>) : null;
  };

  // Hovering a dot on the map or a row in the member list picks out that mob's roam trail; clicking
  // the row pins it, so the trail stays put while you reshape the polygon around it.
  const focusId = () => hover()?.spawn.id ?? rowFocus() ?? pinnedId();
  const pinnedSpawn = () => props.spawns.find(s => s.id === pinnedId());
  const walkerSpawn = () => props.spawns.find(s => s.id === walker());

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A note at the foot of the map that clears itself. A warning is something that did not happen
   * the way it was asked for, so it looks different and stays long enough to be read.
   */
  const flash = (text: string, tone: "ok" | "warn" = "ok") => {
    setToast({ text, warn: tone === "warn" });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), tone === "warn" ? 6000 : 2400);
  };
  const copy = async (text: string) => {
    if (await copyText(text)) flash(`copied ${text}`);
    else flash("the browser would not let this page use the clipboard", "warn");
  };
  onCleanup(() => clearTimeout(toastTimer));

  const active = () => regions().find(r => r.name === activeName());
  /** Reviewing: everything for reading a zone works, nothing that changes it is offered. */
  const canEdit = () => !props.readOnly;
  const matches = (s: Spawn) => {
    const f = filter().toLowerCase();
    return !f || s.name.toLowerCase().includes(f) || s.id.includes(f);
  };
  const asSet = (list: RegionEntry[]): RegionSet => Object.fromEntries(list.map(r => [r.name, { rings: r.rings }]));

  // Colour by the order regions first appeared, so each one added is visibly distinct from the
  // last, and deleting one does not repaint every region after it. Renaming keeps the colour, and
  // undoing a delete brings it back in its own. Regions the list no longer holds (a spawn pointing
  // at a deleted one) fall back to the name hash.
  const hueSlots = new Map<string, number>();
  const hues = createMemo(() => {
    const map: Record<string, number> = {};
    for (const r of regions()) {
      if (!hueSlots.has(r.name)) hueSlots.set(r.name, hueSlots.size);
      map[r.name] = (hueSlots.get(r.name)! * GOLDEN + 0.11) % 1;
    }
    return map;
  });
  // Tolerates a missing name: Solid re-runs a Show's children once before tearing them down, so
  // these get called with the selection that just became null.
  const hueOf = (name?: string | null) => (name ? hues()[name] ?? regionHue(name) : 0);
  const colorOf = (name?: string | null) => new THREE.Color().setHSL(hueOf(name), 0.9, 0.6);
  const cssOf = (name?: string | null) => `hsl(${(hueOf(name) * 360).toFixed(0)} 90% 60%)`;

  createEffect(() => props.onChange(asSet(regions()), assign(), paths()));
  // Carving and its plans act on the selected region; with none selected every click would do
  // nothing under a panel that says "0 found".
  createEffect(() => {
    if (active()) return;
    if (mode() === "obstacles") setMode("select");
    setGrow(null);
    setMerge(null);
  });
  // Switching into review mid-tool would leave that tool taking clicks it is no longer offered for.
  createEffect(() => {
    if (canEdit()) return;
    setMode("select");
    setGrow(null);
    setMerge(null);
    setWalker(null);
  });

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
    return [...thin, ...validate(asSet(settled()), props.spawns, assign(), paths())];
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
  }
  const snap = (): Snapshot => ({
    regions: regions(),
    assign: assign(),
    paths: paths(),
    activeName: activeName(),
    walker: walker(),
    mirror: mirror(),
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
    // The tool in hand stays in hand: undoing a cut after leaving carve mode is not a request to go
    // back into it. Drawing is the exception, since the ring being drawn may be what was undone.
    if (mode() === "draw") setMode("select");
  };

  // Snapshots are taken at operation boundaries, so a whole vertex drag collapses into one step.
  // The label is what the step is called in the history list, so it names the change, not the click.
  const { undoStack, redoStack, checkpoint, undo, redo, rewindTo, forget } = createHistory(snap, restore);

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
    return trailPoints(props.spawns.filter(s => assign()[s.id]?.includes(name)).map(s => s.id));
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
    if (!r || !zoneMesh || !floorIndex || (r.rings[0]?.length ?? 0) < 3) return [];
    const pos = zoneMesh.geometry.getAttribute("position").array as Float32Array;
    const only = floor();
    const up = Math.cos((obstacleSlope() * Math.PI) / 180);
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
      // Inside the outline, holes included: an obstacle half inside an old hole is still one
      // obstacle, and its ring is what grows that hole to fit it.
      if (x < minX || x > maxX || z < minZ || z > maxZ || !inRing(r.rings[0], x, z)) return false;
      // And on this storey: a face that never comes near the ground the mobs walk on here is a
      // wall of the floor above or below, which in a zone of storeys lies under the same outline
      // and was ringed as a 25-yalm "cliff" across open floor. y points down, so above is less.
      const ground = sampleFloor(x, z, lastYOf(r.name, x, z));
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
    const mesh = zoneMesh;
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
    const mesh = zoneMesh;
    if (!mesh) return [];
    const ray = new THREE.Raycaster();
    const from = mesh.localToWorld(new THREE.Vector3(x, y - 60, z));
    const to = mesh.localToWorld(new THREE.Vector3(x, y + 60, z));
    ray.set(from, to.clone().sub(from).normalize());
    ray.far = from.distanceTo(to);
    return ray.intersectObject(mesh, false).map(h => mesh.worldToLocal(h.point.clone()).y);
  };
  const groundRing = (ring: Ring): [Ring, number] => (zoneMesh ? putOnGround(ring, surfacesUnder) : [ring, 0]);
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
    const r = active();
    if (mode() !== "obstacles" || !r || (r.rings[0]?.length ?? 0) < 3 || !walkedCells().size) return [];
    const cell = OBSTACLE_CELL;
    const outline = r.rings[0];
    const near = groundNear(walkedCells(), growClearance(), cell);
    const patches = emptyPatches(outline, near, cell, gapMinArea() / (cell * cell), Math.abs(signedArea(outline)) * 0.25 / (cell * cell));
    // A patch that already lies inside a hole has nothing left to cut.
    const holes = r.rings.slice(1).filter(h => h.length >= 3);
    const out: Ring[] = [];
    for (const cells of patches) {
      const [ix, iz] = cellOf(cells.values().next().value!);
      const y = sampleFloor((ix + 0.5) * cell, (iz + 0.5) * cell, lastYOf(r.name, (ix + 0.5) * cell, (iz + 0.5) * cell));
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
    !props.roam ? "turn on roam data to find them" : !memberTrailAll().length ? "none: no mob in this region has a roam trail" : undefined;
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
    if (!members.length) return flash(`${name} has no mobs to convert`, "warn");
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

    checkpoint(`${name} to a route`);
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
    if (!traced) return flash("no roam trail for that mob", "warn");
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

  /** Switches a route between a loop and walking back along the same legs. */
  const toggleLoop = (id: string) => {
    checkpoint(`${props.spawns.find(s => s.id === id)?.name ?? id} walks back and forth`);
    setPaths(all => ({ ...all, [id]: { ...all[id], loop: all[id].loop === false ? undefined : false } }));
  };

  const dropPath = (id: string) => {
    checkpoint(`drop the route for ${props.spawns.find(s => s.id === id)?.name ?? id}`);
    setPaths(all => {
      const next = { ...all };
      delete next[id];
      return next;
    });
    if (walker() === id) editWalker(null);
    flash(`dropped the route for ${props.spawns.find(s => s.id === id)?.name ?? id}; it stands on its spawn point again`);
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
    if (!pieces.length) return flash(`${name} has no shape left to repair`, "warn");
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

  /** Drops the least important quarter of the selected region's vertices, holes included. */
  const simplifyActive = () => {
    const entry = active();
    if (!entry) return;
    const before = entry.rings.reduce((n, ring) => n + ring.length, 0);
    checkpoint(`simplify ${entry.name}`);
    editActive(r => (r.rings = r.rings.map(ring => simplifyRing(ring, Infinity, Math.ceil(ring.length * 0.75)))));
    const after = active()?.rings.reduce((n, ring) => n + ring.length, 0) ?? before;
    flash(`simplified ${entry.name}: ${before} → ${after} vertices, holes included`);
  };

  /** Puts every vertex of the selected region on the ground, and says how many moved. */
  const groundActive = () => {
    const entry = active();
    if (!entry) return;
    let moved = 0;
    const rings = entry.rings.map(ring => {
      const [out, m] = groundRing(ring);
      moved += m;
      return out;
    });
    if (!moved) return flash(`${entry.name} is on the ground already`);
    checkpoint(`ground ${entry.name}`);
    editActive(r => (r.rings = rings));
    flash(`${moved} ${moved === 1 ? "vertex" : "vertices"} of ${entry.name} put on the ground`);
  };

  const addRegion = () => {
    checkpoint("add a region");
    let n = regions().length + 1;
    while (regions().some(r => r.name === `region_${n}`)) n++;
    const name = `region_${n}`;
    setRegions(rs => [...rs, { name, rings: [[]] }]);
    setActiveName(name);
    startDraw(0);
  };

  // Which ring of the active region a click in draw mode adds to: the outline, or the hole that
  // "+ Hole" just started. Always the last ring, as it was, sent Draw on a region with holes into
  // the newest hole rather than the outline.
  const drawRing = () => {
    const t = tool();
    return t.kind === "draw" ? t.ring : 0;
  };
  const startDraw = (ring: number) => setTool({ kind: "draw", ring });
  const startHole = () => {
    const r = active();
    if (!r) return;
    checkpoint("start a hole");
    editActive(c => c.rings.push([]));
    startDraw(r.rings.length);
  };
  /**
   * Leaves draw mode. A ring too short to be a shape goes, and so does the step that started it,
   * so backing out of "+ Region" or "+ Hole" leaves neither an empty row nor a no-op in History.
   */
  const finishDraw = () => {
    const k = drawRing();
    setMode("select");
    const id = walker();
    if (id) {
      // A route of one leg is not a route; drop it rather than leaving a stub behind.
      if ((paths()[id]?.legs.length ?? 0) < 2) dropPath(id);
      return;
    }
    const r = active();
    if (!r || (r.rings[k]?.length ?? 3) >= 3) return;
    const started = undoStack().at(-1)?.label;
    if (k === 0 && started === "add a region") {
      setRegions(rs => rs.filter(x => x.name !== r.name));
      setActiveName(null);
      forget();
    } else if (k > 0) {
      editActive(c => void c.rings.splice(k, 1));
      if (started === "start a hole") forget();
    }
  };

  // Returns false when the new name is empty or taken, so the input can snap back.
  const renameRegion = (from: string, raw: string) => {
    const to = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!to) return (flash("a region needs a name", "warn"), false);
    if (regions().some(r => r.name === to && r.name !== from)) return (flash(`${to} is already a region's name`, "warn"), false);
    if (to === from) return true;
    checkpoint(`rename ${from} to ${to}`);
    if (!hueSlots.has(to)) hueSlots.set(to, hueSlots.get(from) ?? hueSlots.size);
    setRegions(rs => rs.map(r => (r.name === from ? { ...r, name: to } : r)));
    setAssign(a => Object.fromEntries(Object.entries(a).map(([id, ns]) => [id, ns.map(n => (n === from ? to : n))])));
    if (activeName() === from) setActiveName(to);
    return true;
  };

  const deleteRegion = (name: string) => {
    const orphaned = Object.values(assign()).filter(ns => ns.length === 1 && ns[0] === name).length;
    flash(`deleted ${name}${orphaned ? `; ${mobs(orphaned)} it held now have no region` : ""}, ctrl+z brings it back`);
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

  /**
   * The mobs standing inside the selected region by their own position, narrowed by the filter box
   * like everything else in this panel. A spawn whose region already replaced its `at:` has no
   * position to test.
   */
  const insideActive = createMemo(() => {
    const r = active();
    if (!r) return [];
    const set = asSet(settled());
    return props.spawns.filter(s => s.at && matches(s) && regionAt(set, s.x, s.z, s.y) === r.name);
  });

  const assignInside = (remove: boolean) => {
    const r = active();
    if (!r) return;
    const a = assign();
    const touched = insideActive().filter(s => (remove ? a[s.id] : a[s.id]?.join() !== r.name));
    const filtered = filter() ? ` matching "${filter()}"` : "";
    if (!touched.length) return flash(`no mobs${filtered} inside ${r.name} to ${remove ? "unassign" : "assign"}`, "warn");
    checkpoint(`${remove ? "unassign" : "assign"} what ${r.name} covers`);
    setAssign(prev => {
      const next = { ...prev };
      for (const s of touched) {
        if (remove) delete next[s.id];
        else next[s.id] = [r.name];
      }
      return next;
    });
    flash(`${remove ? "unassigned" : "assigned"} ${mobs(touched.length)}${filtered} ${remove ? "inside" : "to"} ${r.name}`);
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
    if (!built.length) return flash("no roam trails for that region's mobs", "warn");
    checkpoint(`refit ${r.name}`);
    setRegions(rs => rs.map(x => (x.name === r.name ? { name: r.name, rings: built[0].rings } : x)));
    if (built.length > 1) flash(`those trails form ${built.length} clusters, fitted the biggest`, "warn");
    else flash(`refitted ${r.name} to its mobs' trails`);
  };

  /** Builds a new region around a set of mobs' trails and assigns them (plus anything inside it). */
  const buildFrom = (spawns: Spawn[]) => {
    const built = regionsFromPoints(trailPoints(spawns.map(s => s.id)));
    if (!built.length) return flash("no roam trails for those mobs", "warn");

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
    checkpoint(`unassign ${props.spawns.find(s => s.id === id)?.name ?? id}`);
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
    // Only between the two lists: a finding or a history step selects things too, and clicking
    // down those should not throw the reader off the list they are working through.
    const showing = untrack(tab);
    if (showing === "regions" || showing === "paths") setTab(activeName() ? "regions" : "paths");
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
  // `moved` stays false for a press that never became a drag, whose undo step is then dropped.
  let drag: { ring: number; idx: number; inserted: boolean; moved: boolean; } | null = null;
  let spawnDrag: { spawn: Spawn; line: THREE.Line; } | null = null;

  /** Roam points drawn at once. Above this a zone is sampled for display only; see where it is used. */
  const DRAWN_POINT_CAP = 600_000;

  createMemo(() => {
    const { mesh, prep, dispose } = addZoneMesh(scene(), props.zoneData, 0.75);
    zoneMesh = mesh;
    mesh.visible = !untrack(() => props.nav);
    meshPrep = prep;
    floorIndex = buildFloorIndex(mesh, prep);
    setFloors(floorIndex.floors);
    setFloor(null);
    scene().add(overlay);
    onCleanup(dispose);
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
    onCleanup(addNavMesh(scene(), bytes));
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
    geo.setAttribute("lit", new THREE.BufferAttribute(new Float32Array(data.count), 1));

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

  /**
   * Rings drawn as wide lines a little above the ground, for the carve previews. WebGL draws
   * LineBasicMaterial one pixel wide whatever it is told, so these are screen-sized wide lines, as
   * segments: a polyline geometry would join every ring to the next. `clipTo` keeps only the edges
   * inside that ring. Called inside an effect, whose cleanup takes the lines away again.
   */
  const drawRingLines = (
    rings: Ring[],
    o: { key: string; color: number; width: number; lift: number; order: number; dashed?: boolean; clipTo?: Ring; },
  ) => {
    const segments: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (o.clipTo?.length && !inRing(o.clipTo, (a[0] + b[0]) / 2, (a[2] + b[2]) / 2)) continue;
        // A hair above the ground so the line is not swallowed by the terrain it lies on.
        segments.push(a[0], a[1] - o.lift, a[2], b[0], b[1] - o.lift, b[2]);
      }
    }
    if (!segments.length) return;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segments);
    const mat = materialFor(
      o.key,
      () => new LineMaterial({ color: o.color, linewidth: o.width, depthTest: false, dashed: !!o.dashed, dashSize: 1, gapSize: 0.7 }),
    ) as LineMaterial;
    mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
    obstacleLineMaterials.push(mat);
    const lines = new LineSegments2(geo, mat);
    if (o.dashed) lines.computeLineDistances();
    lines.renderOrder = o.order;
    scene().add(lines);
    onCleanup(() => {
      scene().remove(lines);
      geo.dispose();
    });
  };
  const AMBER = 0xffb020;
  const VIOLET = 0xc084fc;

  /**
   * The batch whose button the pointer is on. What Ring all or Cut patches would take is shown
   * before it is taken, loudly: the part of each ring over ground the region still has (exactly
   * what the cut removes) filled and flashing, with a thick outline that throbs.
   */
  const [armed, setArmed] = createSignal<"ringAll" | "patches" | null>(null);
  let flashing: { fill: THREE.MeshBasicMaterial; edge: LineMaterial; base: THREE.Color; } | undefined;
  createEffect(() => {
    const batch = armed();
    const r = active();
    if (!batch || !r || mode() !== "obstacles") return;
    const rings = batch === "ringAll"
      ? ringsAround(bulk(), obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround)
      : gaps();
    const base = new THREE.Color(batch === "ringAll" ? AMBER : VIOLET);
    const fill = new THREE.MeshBasicMaterial({
      color: base.clone(),
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthTest: false,
      ...paintOnce(255),
    });
    const edge = new LineMaterial({ color: 0xffffff, linewidth: 5, depthTest: false, transparent: true });
    const added: THREE.Object3D[] = [];
    const segments: number[] = [];
    for (const ring of rings) {
      for (const piece of regionIntersection({ rings: [ring] }, r)) {
        const flat = [piece.rings[0], ...piece.rings.slice(1)];
        const faces = THREE.ShapeUtils.triangulateShape(
          flat[0].map(([x, , z]) => new THREE.Vector2(x, -z)),
          flat.slice(1).map(h => h.map(([x, , z]) => new THREE.Vector2(x, -z))),
        );
        const geo = new THREE.BufferGeometry();
        // A hair above the region's own fill, which it sits on.
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flat.flat().flatMap(([x, y, z]) => [x, y - 0.15, z])), 3));
        geo.setIndex(faces.flat());
        const mesh = new THREE.Mesh(geo, fill);
        mesh.renderOrder = 6;
        added.push(mesh);
        for (const outline of flat) {
          for (let i = 0; i < outline.length; i++) {
            const a = outline[i], b = outline[(i + 1) % outline.length];
            segments.push(a[0], a[1] - 0.35, a[2], b[0], b[1] - 0.35, b[2]);
          }
        }
      }
    }
    if (segments.length) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(segments);
      const lines = new LineSegments2(geo, edge);
      lines.renderOrder = 7;
      added.push(lines);
    }
    for (const object of added) scene().add(object);
    flashing = { fill, edge, base };
    onCleanup(() => {
      for (const object of added) {
        scene().remove(object);
        (object as THREE.Mesh).geometry.dispose();
      }
      fill.dispose();
      edge.dispose();
      flashing = undefined;
    });
  });
  /** Each frame of the armed preview: the fill flashes and the outline throbs. */
  const flashFrame = (width: number, height: number) => {
    const f = flashing;
    if (!f) return;
    const t = performance.now() / 1000;
    const beat = 0.5 + 0.5 * Math.sin(t * 9); // about 1.4 flashes a second
    f.fill.opacity = 0.15 + 0.7 * beat;
    f.fill.color.copy(f.base).lerp(WHITE, 0.45 * beat);
    f.edge.linewidth = 3 + 5 * beat;
    f.edge.color.copy(f.base).lerp(WHITE, 1 - beat);
    f.edge.resolution.set(width, height);
  };
  const WHITE = new THREE.Color(0xffffff);

  // The obstacles on offer, each drawn as the ring a click would cut, so the margin is visible
  // before anything is changed. What Ring all takes is solid, what is over its size dashed. Only
  // the part inside the region is drawn: the cut clips to the outline, so the preview does too.
  createEffect(() => {
    const { bulk: small, big } = shownPreview();
    const clipTo = active()?.rings[0];
    drawRingLines(small, { key: "obstacles", color: AMBER, width: 2.5, lift: 0.2, order: 3, clipTo });
    drawRingLines(big, { key: "obstacles-big", color: AMBER, width: 2.5, lift: 0.2, order: 3, dashed: true, clipTo });
  });

  // Empty patches on offer, dashed violet: the data's holes rather than the mesh's.
  createEffect(() => drawRingLines(gaps(), { key: "gaps", color: VIOLET, width: 2.5, lift: 0.2, order: 3, dashed: true }));

  // The obstacle under the cursor, drawn as the ring a click would cut.
  createEffect(() => {
    const h = obstacleHover();
    if (!h || mode() !== "obstacles") return;
    const rings = ringsAround([h.obstacle], obstacleMargin(), OBSTACLE_CELL, walkedCells()).map(onGround);
    drawRingLines(rings, { key: "obstacle-hover", color: 0xffffff, width: 3.5, lift: 0.3, order: 5 });
  });

  // The grow plan: the patch of unvisited ground the hole would become.
  createEffect(() => {
    const ring = growPlan()?.ring;
    if (ring) drawRingLines([ring], { key: "grow", color: VIOLET, width: 2.5, lift: 0.25, order: 4 });
  });

  // The merge plan: the hull the group would become, and the holes going into it.
  createEffect(() => {
    const plan = mergePlan();
    if (!plan) return;
    const rings = [...plan.group.map(k => plan.entry.rings[k]), ...(plan.hull ? [plan.hull] : [])];
    drawRingLines(rings, { key: "merge", color: VIOLET, width: 2.5, lift: 0.25, order: 4 });
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
    // The region's own points in the hue opposite its fill, and lighter: the same hue on the same
    // fill was one wash of colour when editing.
    const lit = act ? new THREE.Color().setHSL((hueOf(act) + 0.5) % 1, 1, 0.8) : dim;
    const litAttr = points.geometry.getAttribute("lit") as THREE.BufferAttribute;
    for (const [mobId, [start, count]] of Object.entries(data.ranges)) {
      const mine = !!act && !!a[mobId]?.includes(act);
      const c = mine ? lit : dim;
      for (let i = 0; i < count; i++) {
        colors.setXYZ(start + i, c.r, c.g, c.b);
        litAttr.setX(start + i, mine ? 1 : 0);
      }
    }
    colors.needsUpdate = true;
    litAttr.needsUpdate = true;
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

    for (const [index, r] of list.entries()) {
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
        const ref = fillRef(index);
        const fill = new THREE.Mesh(
          geo,
          materialFor(
            `fill:${color.getHex()}:${isActive}:${ref}`,
            () =>
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: isActive ? 0.45 : 0.3,
                side: THREE.DoubleSide,
                depthTest: false,
                ...paintOnce(ref),
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
      stencil: true, // for paintOnce
      scene: scene(),
      camera: camera(),
      onFrame: dt => {
        for (const m of [...activeLineMaterials, stalkMaterial, ...obstacleLineMaterials]) {
          m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        }
        stepReplay(dt);
        flashFrame(canvasElement.clientWidth, canvasElement.clientHeight);
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
      raycaster.params.Points!.threshold = pixels * worldPerPixel(cam, controls!.target, canvasElement.clientHeight);
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
      if (handle && !handle.mid && canEdit()) {
        checkpoint("remove a vertex");
        return removeVertex(handle); // midpoints are not stored, so there is nothing to remove
      }

      const spawn = pickSpawn();
      if (spawn) return setMenu({ kind: "spawn", spawn, x: ev.clientX, y: ev.clientY });
      const p = pickZonePoint();
      const act = active();
      const hole = p && act && canEdit() ? holeAt(act, p.x, p.z) : 0;
      if (hole) return setMenu({ kind: "hole", name: act!.name, index: hole, x: ev.clientX, y: ev.clientY });
      if (p && act && canEdit() && containsXZ(act, p.x, p.z)) {
        return setMenu({ kind: "ground", name: act.name, x0: p.x, z0: p.z, x: ev.clientX, y: ev.clientY });
      }
      const name = p && regionAt(asSet(regions()), p.x, p.z, p.y);
      setMenu(name ? { kind: "region", name, x: ev.clientX, y: ev.clientY } : null);
    };

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button === 2) rightDownAt = { x: ev.clientX, y: ev.clientY };
      if (ev.button !== 0) return;
      downAt = { x: ev.clientX, y: ev.clientY };
      // Reviewing: the camera, hovering and selection all still work; nothing moves under them.
      if (!canEdit()) return;
      if (ev.altKey) return; // alt is for copying a position, never for dragging something
      aim(ev);
      // Carving: a click near a hole's corner is a click to cut, not a grab. The outline's own
      // corners stay draggable.
      const picked = pickHandle();
      const handle = mode() === "obstacles" && picked && picked.ring > 0 ? null : picked;

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

      const what = activePath() ? "leg" : "vertex";
      checkpoint(handle.mid ? `add a ${what}` : `move a ${what}`);
      if (handle.mid && activePath()) {
        const p = pickZonePoint(activePath()!.legs[handle.idx][1]);
        editPath(legs => {
          const a = legs[handle.idx];
          const b = legs[handle.idx + 1];
          legs.splice(handle.idx + 1, 0, p ? [p.x, p.y, p.z] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
        });
        drag = { ring: 0, idx: handle.idx + 1, inserted: true, moved: false };
      } else if (handle.mid) {
        const p = pickZonePoint(lastY(active()));
        editActive(r => {
          const ring = r.rings[handle.ring];
          const a = ring[handle.idx];
          const b = ring[(handle.idx + 1) % ring.length];
          const mid: Vertex = p ? [p.x, p.y, p.z] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          ring.splice(handle.idx + 1, 0, mid);
        });
        drag = { ring: handle.ring, idx: handle.idx + 1, inserted: true, moved: false };
      } else {
        drag = { ring: handle.ring, idx: handle.idx, inserted: false, moved: false };
      }
      setHover(null); // otherwise a stale hover keeps overriding the pinned trail mid-drag
      controls!.enabled = false;
      ev.preventDefault();
    };

    const onMouseMove = (ev: MouseEvent) => {
      aim(ev);
      setCursor(groundPoint());
      if (!drag && !spawnDrag && mode() === "select" && canEdit()) {
        const act = active();
        const p = act ? pickZonePoint(lastY(act)) : null;
        const k = p && act ? holeAt(act, p.x, p.z) : 0;
        setHoleHover(k && act ? { name: act.name, index: k, x: ev.clientX, y: ev.clientY } : null);
      } else setHoleHover(null);
      if (mode() === "obstacles") {
        const p = pickZonePoint(lastY(active()));
        const o = p && obstacleAt(obstacles(), p.x, p.z, obstacleMargin(), OBSTACLE_CELL);
        setObstacleHover(o ? { obstacle: o, x: ev.clientX, y: ev.clientY } : null);
      } else if (obstacleHover()) setObstacleHover(null);

      if (drag) {
        // A few pixels of wobble on a click is not a move.
        if (!drag.moved && !drag.inserted && downAt && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) <= 3) return;
        drag.moved = true;
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
      // Pressed on a corner and let go without moving it: nothing changed, so no step either.
      if (drag && !drag.inserted && !drag.moved) forget();
      drag = null;
      controls!.enabled = true;
    };

    const onClick = (ev: MouseEvent) => {
      setMenu(null);
      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 3) return;
      aim(ev);

      if (ev.altKey) {
        const p = groundPoint();
        if (p) copy(`!pos ${xyz(p)}`);
        return;
      }
      // A grow or merge plan is open over the map: its preview is what is being decided on, from
      // whichever tool it was opened in.
      if (grow() || merge()) return;
      if (canEdit() && mode() !== "obstacles" && pickHandle()) return;

      if (mode() === "obstacles") {
        if (cutting()) return;
        const p = pickZonePoint(lastY(active()));
        const o = p && obstacleAt(obstacles(), p.x, p.z, obstacleMargin(), OBSTACLE_CELL);
        if (o) ringObstacles([o]);
        else {
          const g = p && gapAt(p.x, p.z);
          if (g) cutRings([g]);
        }
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
        editActive(c => (c.rings[drawRing()] ?? c.rings[0]).push([p.x, p.y, p.z]));
        return;
      }

      // Dots only take the click when there is a region to assign them to; otherwise it falls
      // through to picking a region, so a dot can't block selecting the polygon under it.
      const spawn = pickSpawn();
      const name = activeName();
      if (spawn && name && canEdit()) {
        const had = assign()[spawn.id] ?? [];
        flash(
          had.includes(name)
            ? `took ${spawn.name} out of ${name}`
            : ev.shiftKey
            ? `${spawn.name} is now in ${[...had, name].join(" or ")}`
            : `${spawn.name} is now in ${name}${had.length ? `, was ${had.join(" or ")}` : ""}`,
        );
        checkpoint(had.includes(name) ? `unassign ${spawn.name}` : `assign ${spawn.name}`);
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
      // Hidden behind the YAML view: an undo there would change regions nobody can see.
      if (isTyping(ev.target) || canvasElement.offsetParent === null) return;
      if (ev.key === "Escape" && menu()) return setMenu(null);
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
        const t = tool();
        if (t.kind === "grow" || t.kind === "merge") setTool({ kind: t.back });
        else if (t.kind === "carve") setMode("select");
        else if (replayId()) setReplayId(null);
        else if (walker()) editWalker(null);
        else setActiveName(null);
        return;
      }
      finishDraw();
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
      const perPixel = worldPerPixel(cam, controls!.target, canvasElement.clientHeight);
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
      const perPixel = worldPerPixel(cam, controls!.target, canvasElement.clientHeight);
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
        readOnly={props.readOnly}
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
                  style={{ color: css(PATH_COLOR) }}
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
                  Editing the route of <b style={{ color: css(PATH_COLOR) }}>{spawn().name}</b> <span class="text-slate-400">{spawn().id}</span>
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
                  {canEdit() ? "Editing" : "Viewing"} region <b style={{ color: cssOf(name()) }}>{name()}</b>{" "}
                  <span class="text-slate-400">{`(${mobs(spawnCounts()[name()] ?? 0)})`}</span>
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
                  Replaying <b style={{ color: css(COLORS.reshaped) }}>{spawn().name}</b>{" "}
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
          <MapToolbar
            selected={!!active()}
            carving={mode() === "obstacles"}
            canGround={!!zoneMesh}
            onCarve={() => setMode(m => (m === "obstacles" ? "select" : "obstacles"))}
            onSimplify={simplifyActive}
            onGround={groundActive}
          />
        </Show>
        <Show when={grow()}>
          <PlanPanel
            title="Hole from roam data"
            status={growPlan()?.ring ? `${(growPlan()!.cells.size * OBSTACLE_CELL * OBSTACLE_CELL).toFixed(0)} y²` : growPlan()?.why ?? "…"}
            dial={{
              label: "clearance",
              unit: "y",
              get: growClearance,
              set: setGrowClearance,
              min: 0.5,
              max: 4,
              step: 0.25,
              title: "Ground within this many yalms of a recorded sample is ground the mobs use and stays out of the hole",
            }}
            applyLabel="Apply"
            canApply={!!growPlan()?.ring}
            onApply={growHole}
            onCancel={() => setGrow(null)}
          />
        </Show>
        <Show when={mergePlan()}>
          {plan => (
            <PlanPanel
              title="Merge holes"
              status={`${plan().group.length} in the group`}
              dial={{
                label: "reach",
                unit: "y",
                get: mergeReach,
                set: setMergeReach,
                min: 0.25,
                max: 12,
                step: 0.25,
                title: "A hole whose edge is within this many yalms of the chosen one joins the merge",
              }}
              applyLabel={`Merge ${plan().group.length} holes`}
              canApply={plan().group.length >= 2}
              onApply={mergeHoles}
              onCancel={() => setMerge(null)}
            />
          )}
        </Show>
        <Show when={mode() === "obstacles" && !props.readOnly && !merge() && !grow()}>
          <CarvePanel
            dials={DIALS}
            clearance={{
              label: "clearance",
              unit: "y",
              get: growClearance,
              set: setGrowClearance,
              min: 0.5,
              max: 4,
              step: 0.25,
              title:
                "Ground within this many yalms of a recorded sample is ground the mobs use; enclosed ground beyond it is an empty patch. The same dial as a grow plan's clearance.",
            }}
            patchAtLeast={{
              label: "patch at least",
              unit: "y²",
              get: gapMinArea,
              set: setGapMinArea,
              min: 1,
              max: 60,
              step: 1,
              title: "An empty patch smaller than this, in square yalms, is sampling noise",
            }}
            obstacles={obstacles().length}
            ringAll={bulk().length}
            patches={gaps().length}
            patchesWhyNot={gapsWhyNot()}
            cutting={cutting()}
            onRingAll={() => ringObstacles(bulk())}
            onCutPatches={() => cutRings(gaps())}
            onDefaults={resetObstacleDials}
            onPreview={setArmed}
          />
        </Show>
        <Show when={cursor()}>{at => <CursorReadout at={at()} onCopy={copy} />}</Show>
        <Show when={menu()}>
          <div
            ref={menuElement}
            role="menu"
            class="fixed z-[100] min-w-44 bg-slate-900 border border-slate-600 rounded shadow-lg py-1 text-xs"
            style={{ left: `${menu()!.x}px`, top: `${menu()!.y}px` }}
          >
            <Show when={menuAs("region")?.name}>
              {name => (
                <>
                  <div class="px-3 py-1 text-slate-500">{name()}</div>
                  <Show when={canEdit()}>
                    <MenuItem
                      onClick={() => (convertToPatrol(name()), setMenu(null))}
                    >
                      Turn into a route ({mobs(props.spawns.filter(s => assign()[s.id]?.includes(name())).length)})
                    </MenuItem>
                    <MenuItem onClick={() => (repairShape(name()), setMenu(null))}>
                      Repair the shape
                    </MenuItem>
                  </Show>
                  <MenuItem onClick={() => (centerOn(name()), setMenu(null))}>
                    Centre on it
                  </MenuItem>
                  <Show when={canEdit()}>
                    <MenuItem danger onClick={() => (deleteRegion(name()), setMenu(null))}>
                      Delete region
                    </MenuItem>
                  </Show>
                </>
              )}
            </Show>
            <Show when={menuAs("hole")}>
              {hole => (
                <>
                  <div class="px-3 py-1 text-slate-500">
                    {hole().name} · hole {hole().index} · {Math.abs(signedArea(active()?.rings[hole().index] ?? [])).toFixed(0)} y²
                  </div>
                  <MenuItem
                    onClick={() => (setMerge({ name: hole().name, index: hole().index }), setMenu(null))}
                  >
                    Merge nearby holes… ({active() ? nearHoles(active()!, hole().index, mergeReach()).length : 0} within {mergeReach()}y)
                  </MenuItem>
                  <MenuItem
                    title="Grow this hole over the ground around it that no member mob was recorded on"
                    onClick={() => {
                      const p = { x: 0, z: 0 };
                      const ring = active()?.rings[hole().index];
                      if (ring) (p.x = ring.reduce((t, v) => t + v[0], 0) / ring.length, p.z = ring.reduce((t, v) => t + v[2], 0) / ring.length);
                      setGrow({ name: hole().name, x: p.x, z: p.z, y: ring?.[0]?.[1] ?? 0 });
                      setMenu(null);
                    }}
                  >
                    Grow to roam data…
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => (deleteHole(hole().name, hole().index), setMenu(null))}
                  >
                    Delete hole
                  </MenuItem>
                </>
              )}
            </Show>
            <Show when={menuAs("ground")}>
              {spot => (
                <>
                  <div class="px-3 py-1 text-slate-500">{spot().name} · {spot().x0.toFixed(1)}, {spot().z0.toFixed(1)}</div>
                  <MenuItem
                    title="Cut a hole over the ground around this spot that no member mob was recorded on"
                    onClick={() => {
                      setGrow({ name: spot().name, x: spot().x0, z: spot().z0, y: lastYOf(spot().name, spot().x0, spot().z0) });
                      setMenu(null);
                    }}
                  >
                    Hole from roam data…
                  </MenuItem>
                </>
              )}
            </Show>
            <Show when={menuAs("spawn")?.spawn}>
              {spawn => (
                <>
                  <div class="px-3 py-1 text-slate-500">{spawn().name} {spawn().id}</div>
                  <Show when={canEdit()}>
                    <MenuItem
                      onClick={() => (startPath(spawn()), setMenu(null))}
                    >
                      Trace a route
                    </MenuItem>
                  </Show>
                  <MenuItem
                    onClick={() => {
                      setMenu(null);
                      if (replayId() === spawn().id) return setReplayId(null);
                      if (trailPoints([spawn().id]).length < 2) return flash(`no roam trail for ${spawn().name}`, "warn");
                      setReplayId(spawn().id);
                    }}
                  >
                    {replayId() === spawn().id ? "Stop the replay" : "Replay its trail"}
                  </MenuItem>
                  <Show when={canEdit() && activeName()}>
                    <MenuItem
                      onClick={() => {
                        checkpoint(`assign ${spawn().name} to ${activeName()}`);
                        setAssign(a => ({ ...a, [spawn().id]: [activeName()!] }));
                        setMenu(null);
                      }}
                    >
                      Assign to {activeName()}
                    </MenuItem>
                  </Show>
                  <MenuItem onClick={() => (flyTo(spawn().x, spawn().y, spawn().z), setMenu(null))}>
                    Centre on it
                  </MenuItem>
                </>
              )}
            </Show>
            <Show when={menuAs("route") && routeGroups().find(g => g.lead === menuAs("route")!.lead)}>
              {group => (
                <>
                  <div class="px-3 py-1 text-slate-500">
                    {props.spawns.find(s => s.id === group().lead)?.name ?? group().lead}
                    {group().ids.length > 1 ? ` and ${group().ids.length - 1} more` : ""}
                  </div>
                  <Show when={canEdit()}>
                    <MenuItem onClick={() => (selectRoute(group().lead), setMenu(null))}>
                      Edit the legs
                    </MenuItem>
                    <MenuItem onClick={() => (retrace(group().lead), setMenu(null))}>
                      Re-trace from the roam trail
                    </MenuItem>
                  </Show>
                  <MenuItem
                    onClick={() => (setReplayId(replayId() === group().lead ? null : group().lead), setMenu(null))}
                  >
                    {replayId() === group().lead ? "Stop the replay" : "Replay the trail it came from"}
                  </MenuItem>
                  <Show when={canEdit()}>
                    <MenuItem
                      danger
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
                    </MenuItem>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
        <Show when={toast()}>
          <div
            role="status"
            class="absolute bottom-2 left-1/2 -translate-x-1/2 text-white text-xs font-mono rounded px-3 py-1 pointer-events-none max-w-[80%] text-center"
            classList={{ "bg-emerald-600": !toast()!.warn, "bg-amber-600": toast()!.warn }}
          >
            {toast()!.text}
          </div>
        </Show>
        <Show when={obstacleHover() && mode() === "obstacles" && !menu()}>
          <CursorTooltip x={obstacleHover()!.x} y={obstacleHover()!.y}>
            <div class="font-bold">
              {isCliff(obstacleHover()!.obstacle) ? "cliff line" : "obstacle"} · {obstacleArea(obstacleHover()!.obstacle, OBSTACLE_CELL).toFixed(0)} y²
            </div>
            <div class="text-slate-400">
              {(obstacleHover()!.obstacle.foot - obstacleHover()!.obstacle.top).toFixed(1)} y tall · click to ring it
              {obstacleArea(obstacleHover()!.obstacle, OBSTACLE_CELL) > obstacleBulkMax() ? " · over the ring-all size" : ""}
            </div>
          </CursorTooltip>
        </Show>
        <Show when={holeHover() && !hover() && !menu()}>
          <CursorTooltip x={holeHover()!.x} y={holeHover()!.y}>
            <div class="font-bold">hole {holeHover()!.index}</div>
            <div class="text-slate-400">
              {Math.abs(signedArea(active()?.rings[holeHover()!.index] ?? [])).toFixed(0)} y² · {active()?.rings[holeHover()!.index]?.length ?? 0} vertices
            </div>
            <div class="text-slate-500">right-click to delete, merge or grow it</div>
          </CursorTooltip>
        </Show>
        <Show when={hover()}>
          <CursorTooltip x={hover()!.x} y={hover()!.y}>
            <div class="font-bold">{hover()!.spawn.name}</div>
            <div class="text-slate-400">{hover()!.spawn.id}</div>
            <div class="text-slate-400">
              {hover()!.spawn.x.toFixed(1)}, {hover()!.spawn.y.toFixed(1)}, {hover()!.spawn.z.toFixed(1)}
            </div>
            {/* A fixed point is not necessarily an oversight: plenty of mobs are meant to stand still. */}
            <div style={{ color: assign()[hover()!.spawn.id]?.length ? cssOf(assign()[hover()!.spawn.id][0]) : "#888" }}>
              {/* "or", not "and": the server picks one of them each time the mob spawns. */}
              {assign()[hover()!.spawn.id]?.join(" or ")
                ?? (paths()[hover()!.spawn.id] ? "walks a route" : "no region: stands on its fixed point")}
            </div>
            <Show when={props.roam?.ranges[hover()!.spawn.id]}>
              <div class="text-slate-400">{props.roam!.ranges[hover()!.spawn.id][1]} roam points</div>
            </Show>
          </CursorTooltip>
        </Show>
      </div>

      <div class="w-80 flex flex-col bg-slate-800 rounded-lg p-2 overflow-hidden text-sm">
        <div class="flex gap-1 mb-2" role="tablist">
          <button
            class="flex-1 px-1 py-1 rounded text-xs whitespace-nowrap"
            classList={{ "bg-slate-600": tab() === "regions", "bg-slate-700 text-slate-400": tab() !== "regions" }}
            role="tab"
            aria-selected={tab() === "regions"}
            onClick={() => setTab("regions")}
          >
            Regions ({regions().length})
          </button>
          <button
            class="flex-1 px-1 py-1 rounded text-xs whitespace-nowrap"
            classList={{ "bg-slate-600": tab() === "paths", "bg-slate-700 text-slate-400": tab() !== "paths" }}
            role="tab"
            aria-selected={tab() === "paths"}
            onClick={() => setTab("paths")}
          >
            Routes ({Object.keys(paths()).length})
          </button>
          <button
            class="flex-1 px-1 py-1 rounded text-xs whitespace-nowrap"
            classList={{ "bg-slate-600": tab() === "review", "bg-slate-700 text-slate-400": tab() !== "review" }}
            title="Checks every region and how well each covers its mobs' trails. Runs while this tab is open; ? means the regions have changed since the last check."
            role="tab"
            aria-selected={tab() === "review"}
            onClick={() => setTab("review")}
          >
            Review ({reviewStale() ? "?" : findings().filter(f => f.level !== "info").length})
          </button>
          <button
            class="flex-1 px-1 py-1 rounded text-xs whitespace-nowrap"
            classList={{ "bg-slate-600": tab() === "history", "bg-slate-700 text-slate-400": tab() !== "history" }}
            role="tab"
            aria-selected={tab() === "history"}
            onClick={() => setTab("history")}
          >
            History ({undoStack().length})
          </button>
        </div>

        <Show when={tab() === "history"}>
          <HistoryTab undoStack={undoStack()} redoStack={redoStack()} onUndo={undo} onRedo={redo} onRewind={rewindTo} />
        </Show>

        <Show when={tab() === "paths"}>
          <RoutesTab
            paths={paths()}
            spawns={props.spawns}
            walker={walker()}
            canEdit={canEdit()}
            rowRef={(id, el) => rowRefs.set(id, el)}
            onSelect={selectRoute}
            onMenu={(id, x, y) => setMenu({ kind: "route", lead: routeGroups().find(g => g.ids.includes(id))?.lead ?? id, x, y })}
            onToggleLoop={toggleLoop}
            onRetrace={retrace}
            onAddLegs={id => (selectRoute(id), setMode("draw"))}
            onDrop={dropPath}
          />
        </Show>

        <Show when={tab() === "review"}>
          <ReviewList findings={findings()} onJump={jumpTo} onRepair={canEdit() ? repairShape : undefined} />
        </Show>

        <Show when={tab() === "regions"}>
          <RegionsTab
            canEdit={canEdit()}
            drawing={mode() === "draw"}
            selected={active()?.name ?? null}
            onAddRegion={addRegion}
            onStartHole={startHole}
            onToggleDraw={() => (mode() === "draw" ? finishDraw() : startDraw(0))}
            floors={floors()}
            floor={floor()}
            onFloor={setFloor}
            hideAssigned={hideAssigned()}
            onHideAssigned={setHideAssigned}
            left={props.spawns.length - Object.keys(assign()).length}
            terrainColors={terrainColors()}
            onTerrainColors={setTerrainColors}
            regions={regions().filter(onRegionFloor)}
            colorOf={cssOf}
            counts={spawnCounts()}
            coverage={coverage()}
            coverageStale={reviewStale()}
            rowRef={(name, el) => rowRefs.set(name, el)}
            onSelect={name => (setActiveName(name), zoomTo(name))}
            onMenu={(name, x, y) => setMenu({ kind: "region", name, x, y })}
            onRename={renameRegion}
            onCentre={centerOn}
            onDelete={deleteRegion}
            filter={filter()}
            onFilter={setFilter}
            inside={insideActive().length}
            onAssignInside={assignInside}
            canRefit={!!props.roam}
            onRefit={refitActive}
            members={members()}
            pinnedId={pinnedId()}
            onRowFocus={setRowFocus}
            onPin={id => setPinnedId(current => (current === id ? null : id))}
            onFly={s => flyTo(s.x, s.y, s.z)}
            onUnassign={unassign}
          />
        </Show>
      </div>
    </div>
  );
}

/** One entry in the map's context menu. `danger` for the ones that delete something. */
function MenuItem(props: { danger?: boolean; title?: string; onClick: () => void; children: JSX.Element; }) {
  return (
    <button
      role="menuitem"
      class="block w-full text-left px-3 py-1 hover:bg-slate-700 focus:bg-slate-700 outline-none"
      classList={{ "text-red-400": props.danger }}
      title={props.title}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}
