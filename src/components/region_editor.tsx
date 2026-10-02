import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import * as THREE from "three";
import { Line2, LineGeometry, LineMaterial, LineSegments2, LineSegmentsGeometry, MapControls } from "three/examples/jsm/Addons.js";
import zoneLineBoxes from "../data/zonelines.json";
import { zoneOfFolder } from "../data/zones";
import { inRing, signedArea } from "../geometry";
import { createMapCamera, fitCameraToContents } from "../graphics/camera";
import { buildFloorIndex, type FloorIndex } from "../graphics/floors";
import { parseNavMesh } from "../graphics/navmesh";
import { beaconMaterial, cometMaterial, handleMaterial, roamMaterial, spawnMaterial } from "../graphics/region_points";
import { addNavMesh, addZoneMesh, fillRef, groundColours, groundUnder, paintOnce, worldPerPixel } from "../graphics/region_scene";
import { setupBaseScene } from "../graphics/scene";
import { createViewer } from "../graphics/viewer";
import { ColorKind, colorMesh, prepareMeshData } from "../graphics/ximesh";
import { gridOf, gridPos, sheetOf } from "../map_grid";
import { obstacleArea, obstacleAt, ringsAround } from "../obstacles";
import {
  containmentTest,
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
import { indexNav, simulate, SNAP_TOLERANCE } from "../spawn_sim";
import { COLORS, contrastHue, css } from "../theme";
import type { ZoneData } from "../types";
import { copyText, isTyping } from "../util";
import { type TriggerArea, type ZoneLine, zoneLineBox } from "../zone_features";
import { loadNavMesh } from "../zone_mesh";
import { createCarve, type GrowPlan, type MergePlan, OBSTACLE_CELL, type RegionEntry } from "./carve";
import { CarvePanel, PlanPanel } from "./carve_panels";
import EditorMenu, { type MenuActions, type MenuTarget } from "./editor_menu";
import { createHistory } from "./history";
import HistoryTab from "./history_tab";
import { CursorReadout, CursorTooltip, xyz } from "./map_overlays";
import MapToolbar from "./map_toolbar";
import MobList from "./region_mob_list";
import ShortcutsCard from "./region_shortcuts";
import RegionsTab from "./regions_tab";
import ReviewList from "./review_list";
import RoutesTab from "./routes_tab";

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
  /** Where to look when the zone opens, from a shared link. */
  view?: EditorView;
  /** Where it is looking now, each time that settles, so the page can keep it in its link. */
  onView?: (view: EditorView) => void;
  /** The zone's trigger areas and zone lines, from the server's files, to draw for reference. */
  features?: EditorFeatures;
}

/** What the server's files place in a zone besides its mobs. */
export interface EditorFeatures {
  triggers: { areas: TriggerArea[]; computed: number; };
  lines: ZoneLine[];
  /** Zone lines from other zones into this one, each with the zone it comes from. */
  arrivals: (ZoneLine & { comesFrom: string; })[];
}

/** What a link can say about the view: the camera, the region picked, the floor shown. */
export interface EditorView {
  /** Orbit target then camera position, world space. */
  camera?: number[];
  region?: string;
  floor?: number;
}

// "obstacles" is a click mode too: each click rings the steep faces under it with a hole.
type Mode = "select" | "draw" | "obstacles";

/**
 * What the map is doing with a click. One of these at a time: kept as separate flags they could all
 * be set at once, and a click then did whichever branch came first, under a panel that belonged to
 * another. A grow or merge plan remembers the tool it was opened from, to go back to.
 */
type Tool =
  | { kind: "select"; }
  | {
    kind: "draw";
    /** Which ring of the region a click adds to; routes ignore it. */
    ring: number;
    /** The region being drawn, so leaving the tool tidies up the right one. */
    region: string | null;
  }
  | { kind: "carve"; }
  | { kind: "grow"; plan: GrowPlan; back: "select" | "carve"; }
  | { kind: "merge"; plan: MergePlan; back: "select" | "carve"; };

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
  const [tool, setToolRaw] = createSignal<Tool>({ kind: "select" });
  /**
   * Every change of tool comes through here, so leaving a drawing by any route (another tool, another
   * region, + Region again) tidies it up as Done does, rather than saving a ring of one or two points.
   */
  const setTool = (next: Tool) => {
    // Untracked: an effect that sets the tool would otherwise subscribe to it and set it forever.
    const now = untrack(tool);
    setToolRaw(next);
    if (now.kind === "draw" && !(next.kind === "draw" && next.ring === now.ring && next.region === now.region)) untrack(() => closeDraw(now));
  };
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
    setTool(m === "draw" ? { kind: "draw", ring: 0, region: activeName() } : m === "obstacles" ? { kind: "carve" } : { kind: "select" });
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
  /** Ground under the middle of the view once the camera stops: which map the grid is from when no
   * floor is picked, and the height it is laid at. */
  const [viewGround, setViewGround] = createSignal<{ floor: number | null; y: number; } | null>(null);
  /** The floor whose map the grid and the map sheet are drawn from: the one picked, else the one in view. */
  const mapFloor = () => floor() ?? (floors().length > 1 ? viewGround()?.floor ?? null : floors()[0] ?? 0);
  /** The game's map grid over the zone, for the floor on screen. Always shown. */
  const grid = createMemo(() => gridOf(props.zoneData.id, mapFloor()));
  /** The game's own map sheet laid over the zone, under the regions. */
  const [showSheet, setShowSheet] = createSignal(false);
  const sheet = createMemo(() => (showSheet() ? sheetOf(props.zoneData.id, mapFloor()) : null), undefined, {
    equals: (a, b) => a?.file === b?.file,
  });
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
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [toast, setToast] = createSignal<{ text: string; warn: boolean; } | undefined>();
  const [rowFocus, setRowFocus] = createSignal<string | null>(null);
  const [pinnedId, setPinnedId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<MenuTarget | null>(null);

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
  // The ground colour under each region, read off the mesh once it is built. Settled regions,
  // so a drag does not resample the ground on every mouse move.
  const [ground, setGround] = createSignal<ReturnType<typeof groundColours>>();
  const groundHues = createMemo(() => {
    const g = ground();
    const out: Record<string, { h: number; s: number; l: number; } | undefined> = {};
    if (!g) return out;
    for (const r of settled()) if ((r.rings[0]?.length ?? 0) >= 3) out[r.name] = groundUnder(g, r.rings[0], (x, z) => inRing(r.rings[0], x, z));
    return out;
  });
  // Equal when no region's hue moved, which is nearly always: a new object on every vertex drag sent
  // every point, label and spawn dot that colours by region round to be repainted.
  const hues = createMemo(
    () => {
      const map: Record<string, number> = {};
      const under = groundHues();
      for (const r of regions()) {
        if (!hueSlots.has(r.name)) hueSlots.set(r.name, hueSlots.size);
        map[r.name] = contrastHue((hueSlots.get(r.name)! * GOLDEN + 0.11) % 1, under[r.name]);
      }
      return map;
    },
    undefined,
    { equals: (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]) },
  );
  // Tolerates a missing name: Solid re-runs a Show's children once before tearing them down, so
  // these get called with the selection that just became null.
  const hueOf = (name?: string | null) => (name ? hues()[name] ?? regionHue(name) : 0);
  const colorOf = (name?: string | null) => new THREE.Color().setHSL(hueOf(name), 0.9, 0.6);
  const cssOf = (name?: string | null) => `hsl(${(hueOf(name) * 360).toFixed(0)} 90% 60%)`;

  /** A corner is being dragged: the page hears about the shape when it is let go, not on every move. */
  const [dragging, setDragging] = createSignal(false);
  createEffect(() => {
    const rs = regions(), a = assign(), p = paths();
    if (!dragging()) props.onChange(asSet(rs), a, p);
  });
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
      // One indexed test per region, built on first use: walking each outline per point froze the
      // page for seconds in zones with millions of points.
      const tests = new Map<string, (x: number, z: number) => boolean>();
      const testOf = (name: string) => tests.get(name) ?? tests.set(name, containmentTest(set[name])).get(name)!;
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
          const inside = testOf(name);
          for (let i = 0; i < count; i++) {
            const o = (start + i) * 3;
            tally[1]++;
            if (inside(data.positions[o], data.positions[o + 2])) tally[0]++;
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

  // The server's navmesh, loaded when the spawn simulation or the review needs it rather than with
  // the zone: it is a few MB, and most edits never ask for it.
  const [simulating, setSimulating] = createSignal(false);
  const [navIndex] = createResource(
    () => (simulating() || tab() === "review" ? props.zoneData.id : undefined),
    async id => indexNav(parseNavMesh(props.nav ?? (await loadNavMesh(id, () => {}))).tiles.map(t => t.positions)),
  );
  const nav = () => (navIndex.state === "ready" ? navIndex() : undefined);
  /** The same draws every time for the same region, so the review does not change on its own. */
  const seeded = (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296);
  };

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
    // Sixty-four draws, as the server makes when it checks a region at load: none surviving and
    // the server will not use the region; most thrown away and every spawn costs it retries.
    const walkable: Finding[] = [];
    const index = nav();
    for (const r of index ? settled() : []) {
      const draws = simulate(r, index!, 64, seeded(r.name));
      if (!draws.length) continue;
      const kept = draws.filter(d => d.ok).length / draws.length;
      if (!kept) walkable.push({ level: "error", region: r.name, text: `${r.name}: no spawn draw lands on the navmesh, so the server will not use it` });
      else if (kept < 0.5) {
        walkable.push({ level: "warn", region: r.name, text: `${r.name}: only ${(kept * 100).toFixed(0)}% of spawn draws land on the navmesh` });
      }
    }
    return [...walkable, ...thin, ...validate(asSet(settled()), props.spawns, assign(), paths())];
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
    // back into it. Drawing is the exception, since the ring being drawn may be what was undone;
    // left without tidying, since the snapshot is already what it should be.
    if (mode() === "draw") setToolRaw({ kind: "select" });
  };

  // Snapshots are taken at operation boundaries, so a whole vertex drag collapses into one step.
  // The label is what the step is called in the history list, so it names the change, not the click.
  const history = createHistory(snap, restore);
  const { undoStack, redoStack, checkpoint, forget } = history;
  // Not while holes are being cut: the cut finishes from the shape it started on, and would quietly
  // put back whatever an undo in the meantime took away.
  const unlessCutting = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) =>
    cutting() ? flash("still cutting holes; try again when it is done", "warn") : fn(...args);
  const undo = unlessCutting(() => {
    const label = history.undo();
    if (label) flash(`undid: ${label}`);
  });
  const redo = unlessCutting(() => {
    const label = history.redo();
    if (label) flash(`redid: ${label}`);
  });
  const rewindTo = unlessCutting(history.rewindTo);

  // --- carving: obstacles, empty patches, growing and merging holes (see carve.ts) ---
  const {
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
  } = createCarve({
    regions,
    setRegions,
    settled,
    setSettled,
    activeName,
    mode,
    floor,
    zoneMesh: () => zoneMesh,
    floorIndex: () => floorIndex,
    trailOf: name => trailPoints(props.spawns.filter(s => assign()[s.id]?.includes(name)).map(s => s.id)),
    hasRoam: () => !!props.roam,
    grow,
    setGrow,
    merge,
    setMerge,
    checkpoint,
    flash,
    setHoleHover,
  });

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
    // Nothing to take out: no step in History for it, and no claim that it did something.
    if (after === before) return (forget(), flash(`${entry.name} is as simple as it gets`));
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
  const startDraw = (ring: number) => setTool({ kind: "draw", ring, region: activeName() });
  const startHole = () => {
    const r = active();
    if (!r) return;
    checkpoint("start a hole");
    editActive(c => c.rings.push([]));
    startDraw(r.rings.length);
  };
  const finishDraw = () => setMode("select");
  /**
   * What leaving a drawing does. A ring too short to be a shape goes, and so does the step that
   * started it, so backing out of "+ Region" or "+ Hole" leaves neither an empty row nor a no-op in
   * History.
   */
  const closeDraw = (drawn: { ring: number; region: string | null; }) => {
    const id = walker();
    if (id) {
      // A route of one leg is not a route; drop it rather than leaving a stub behind.
      if ((paths()[id]?.legs.length ?? 0) < 2) dropPath(id);
      return;
    }
    const k = drawn.ring;
    const r = regions().find(x => x.name === drawn.region);
    if (!r || (r.rings[k]?.length ?? 3) >= 3) return;
    const started = undoStack().at(-1)?.label;
    if (k === 0 && started === "add a region") {
      setRegions(rs => rs.filter(x => x.name !== r.name));
      if (activeName() === r.name) setActiveName(null);
      forget();
    } else if (k > 0) {
      setRegions(rs => rs.map(x => (x.name === r.name ? { name: x.name, rings: x.rings.filter((_, i) => i !== k) } : x)));
      if (started === "start a hole") forget();
    }
  };
  // Picking another region ends a drawing, or the next clicks would add to the one just picked.
  createEffect(on(activeName, name => {
    const t = tool();
    if (t.kind === "draw" && !walker() && t.region !== name) finishDraw();
  }, { defer: true }));

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
  const drawnSpawns: number[] = [];
  let handlePoints: THREE.Points | undefined;
  let spawnPoints: THREE.Points | undefined;
  let roamPoints: THREE.Points | undefined;
  let lastFocusRange: [number, number] | undefined;
  let zoneMesh: THREE.Mesh | undefined;
  let floorIndex: FloorIndex | undefined;
  /** The in-game grid square of a spot, as <pos> gives it, on whichever floor the mesh puts it. */
  const gridAt = (x: number, y: number, z: number) => gridPos(props.zoneData.id, floorIndex?.at(x, y, z) ?? null, x, z);
  let meshPrep: ReturnType<typeof prepareMeshData> | undefined;
  // `moved` stays false for a press that never became a drag, whose undo step is then dropped.
  let drag: { ring: number; idx: number; inserted: boolean; moved: boolean; } | null = null;
  let spawnDrag: { spawn: Spawn; line: THREE.Line; } | null = null;

  /** Roam points drawn at once. Above this a zone is sampled for display only; see where it is used. */
  const DRAWN_POINT_CAP = 600_000;

  createMemo(() => {
    const { mesh, prep, dispose } = addZoneMesh(scene(), props.zoneData, 0.75);
    zoneMesh = mesh;
    setGround(groundColours(mesh));
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
    // Settled, since a region does not change floor in the middle of a drag.
    for (const r of settled()) {
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

  // Recorded roam trails, so a polygon can be checked against where the mobs actually went.
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
    // Over the fills, under the outlines: under a fill, a region's own trails were lost in it.
    points.renderOrder = 1.5;
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

  // The grid lines, faint and over everything, at the height of the ground in view.
  createEffect(() => {
    const g = grid();
    if (!g) return;
    const y = untrack(viewGround)?.y ?? 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(g.lines.flatMap(([x1, z1, x2, z2]) => [x1, y, z1, x2, y, z2])), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.45, depthTest: false });
    const lines = new THREE.LineSegments(geo, material);
    lines.renderOrder = 3;
    scene().add(lines);
    onCleanup(() => {
      scene().remove(lines);
      geo.dispose();
      material.dispose();
    });
  });
  const gridHeaderRefs = new Map<string, HTMLDivElement>();
  createEffect(() => {
    const sh = sheet();
    if (!sh) return;
    const y = untrack(viewGround)?.y ?? 0;
    const texture = new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL.replace(/\/$/, "")}/maps/${sh.file}.webp`,
      undefined,
      undefined,
      () => flash("no map sheet for this floor", "warn"),
    );
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([sh.x0, y, sh.z0, sh.x1, y, sh.z0, sh.x1, y, sh.z1, sh.x0, y, sh.z1]), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(geo, material);
    // Over the terrain, under everything drawn on it.
    plane.renderOrder = 0.3;
    scene().add(plane);
    onCleanup(() => {
      scene().remove(plane);
      geo.dispose();
      material.dispose();
      texture.dispose();
    });
  });

  // The zone's trigger areas and zone lines, drawn over the map for reference. Trigger areas pink,
  // zone line entrances cyan, the boxes zone lines from elsewhere land in green.
  const [showZoneInfo, setShowZoneInfo] = createSignal(false);
  const zoneInfo = () => (showZoneInfo() ? props.features : undefined);
  const placeName = (folder: string) => zoneOfFolder(folder)?.name ?? folder;
  /** The ground under x/z near a height, or that height when the mesh has nothing there. */
  const groundBelow = (x: number, z: number, nearY: number) => {
    const tree = zoneMesh?.geometry.boundsTree;
    const hit = tree?.raycastFirst(new THREE.Ray(new THREE.Vector3(x, nearY - 20, z), new THREE.Vector3(0, 1, 0)), THREE.DoubleSide, 0, 200);
    return hit ? hit.point.y : nearY;
  };
  const featureLabels = createMemo(() => {
    const f = zoneInfo();
    if (!f) return [];
    const y = untrack(viewGround)?.y ?? 0;
    const items = [
      ...f.triggers.areas.map(a => ({
        key: `t${a.id}:${a.kind}`,
        text: `trigger ${a.id}`,
        tone: "text-pink-300",
        at: (a.kind === "cuboid"
          ? [(a.min[0] + a.max[0]) / 2, Math.min(a.min[1], a.max[1]), (a.min[2] + a.max[2]) / 2]
          : a.kind === "sphere"
          ? a.centre
          : [a.x, groundBelow(a.x, a.z, y), a.z]) as Vertex,
      })),
      ...f.lines.map(l => ({ key: `l${l.id}`, text: `to ${placeName(l.to)}`, tone: "text-cyan-300", at: l.from })),
      ...f.arrivals.map(l => ({ key: `a${l.comesFrom}:${l.id}`, text: `from ${placeName(l.comesFrom)}`, tone: "text-green-300", at: l.at })),
    ];
    // Labels within a few yalms of each other share one, a line each: a gate's way out and the
    // way in beside it, or two zone lines into the same corridor, were printed on top of each other.
    const groups: { key: string; at: Vertex; lines: { text: string; tone: string; }[]; }[] = [];
    for (const item of items) {
      const near = groups.find(g => Math.hypot(g.at[0] - item.at[0], g.at[2] - item.at[2]) < 12 && Math.abs(g.at[1] - item.at[1]) < 8);
      const line = { text: item.text, tone: item.tone };
      if (!near) groups.push({ key: item.key, at: item.at, lines: [line] });
      else if (!near.lines.some(l => l.text === line.text)) near.lines.push(line);
    }
    return groups;
  });
  const featureLabelRefs = new Map<string, HTMLDivElement>();

  createEffect(() => {
    const f = zoneInfo();
    if (!f) return;
    const y = untrack(viewGround)?.y ?? 0;
    const pink: number[] = [], cyan: number[] = [], green: number[] = [];
    const segment = (into: number[], a: Vertex, b: Vertex) => into.push(...a, ...b);
    const loop = (into: number[], points: Vertex[]) => points.forEach((p, i) => segment(into, p, points[(i + 1) % points.length]));
    const circle = (into: number[], x: number, cy: number, z: number, r: number) =>
      loop(into, Array.from({ length: 48 }, (_, i) => [x + Math.cos((i / 48) * Math.PI * 2) * r, cy, z + Math.sin((i / 48) * Math.PI * 2) * r] as Vertex));
    for (const a of f.triggers.areas) {
      if (a.kind === "cuboid") {
        // The server turns a point into the box's frame about its middle; the corners go the other way.
        const cx = (a.min[0] + a.max[0]) / 2, cz = (a.min[2] + a.max[2]) / 2;
        const c = Math.cos(a.rotation), sn = Math.sin(a.rotation);
        const corner = (x: number, yy: number, z: number): Vertex => {
          const u = x - cx, v = z - cz;
          return [cx + u * c - v * sn, yy, cz + u * sn + v * c];
        };
        const rect = (
          yy: number,
        ) => [corner(a.min[0], yy, a.min[2]), corner(a.max[0], yy, a.min[2]), corner(a.max[0], yy, a.max[2]), corner(a.min[0], yy, a.max[2])];
        const top = rect(a.min[1]), bottom = rect(a.max[1]);
        loop(pink, top);
        loop(pink, bottom);
        top.forEach((p, i) => segment(pink, p, bottom[i]));
      } else if (a.kind === "sphere") circle(pink, a.centre[0], a.centre[1], a.centre[2], a.radius);
      else circle(pink, a.x, groundBelow(a.x, a.z, y), a.z, a.radius);
    }
    // A zone line's own size is the client's; a small diamond marks where it is.
    // A box turned about its middle: the eight corners, then its twelve edges.
    const box = (into: number[], [cx, cy, cz]: Vertex, [sx, sy, sz]: Vertex, turn: number) => {
      const c = Math.cos(turn), sn = Math.sin(turn);
      const at = (u: number, v: number, w: number): Vertex => [cx + u * c - w * sn, cy + v, cz + u * sn + w * c];
      const ring = (v: number) => [at(-sx / 2, v, -sz / 2), at(sx / 2, v, -sz / 2), at(sx / 2, v, sz / 2), at(-sx / 2, v, sz / 2)];
      const top = ring(-sy / 2), bottom = ring(sy / 2);
      loop(into, top);
      loop(into, bottom);
      top.forEach((p, i) => segment(into, p, bottom[i]));
    };
    for (const l of f.lines) {
      const found = zoneLineBox(l, zoneLineBoxes as Record<string, number[]>);
      // The client turns the other way round from the server's trigger boxes.
      if (found) box(cyan, found.centre, found.size, -found.rotation);
      // Not in the client's data: a small diamond where the server has it.
      else {loop(cyan, [[l.from[0] + 3, l.from[1], l.from[2]], [l.from[0], l.from[1], l.from[2] + 3], [l.from[0] - 3, l.from[1], l.from[2]], [
          l.from[0],
          l.from[1],
          l.from[2] - 3,
        ]]);}
    }
    for (const l of f.arrivals) {
      const [w, d] = [l.scale[0] / 2, l.scale[1] / 2];
      loop(green, [[l.at[0] - w, l.at[1], l.at[2] - d], [l.at[0] + w, l.at[1], l.at[2] - d], [l.at[0] + w, l.at[1], l.at[2] + d], [
        l.at[0] - w,
        l.at[1],
        l.at[2] + d,
      ]]);
    }
    const added: THREE.LineSegments[] = [];
    for (const [points, color] of [[pink, 0xf472b6], [cyan, 0x22d3ee], [green, 0x4ade80]] as const) {
      if (!points.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      lines.renderOrder = 7;
      scene().add(lines);
      added.push(lines);
    }
    onCleanup(() => {
      for (const lines of added) {
        scene().remove(lines);
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
      }
    });
  });

  /** The region under the cursor while none is selected, drawn glowing in its own colour. */
  const [hoverRegion, setHoverRegion] = createSignal<string | null>(null);
  let glow: LineMaterial | undefined;
  createEffect(() => {
    const name = hoverRegion();
    const r = name && !active() ? regions().find(x => x.name === name) : undefined;
    if (!r) return;
    const material = new LineMaterial({ color: colorOf(r.name).getHex(), linewidth: 4, depthTest: false, transparent: true });
    const lines: Line2[] = [];
    // The outline alone: glowing every hole too turned a carved region into a cluster of blobs.
    for (const ring of r.rings.slice(0, 1)) {
      if (ring.length < 2) continue;
      const geo = new LineGeometry();
      geo.setPositions([...ring.flat(), ...ring[0]]);
      const line = new Line2(geo, material);
      line.renderOrder = 5;
      scene().add(line);
      lines.push(line);
    }
    glow = material;
    onCleanup(() => {
      for (const line of lines) (scene().remove(line), line.geometry.dispose());
      material.dispose();
      if (glow === material) glow = undefined;
    });
  });

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

  /**
   * Spawns as the server would make them in the selected region: green where it would put a mob,
   * red where the draw falls off the navmesh and gets drawn again. "Draw again" is a new roll.
   */
  const SIM_DRAWS = 400;
  const [roll, setRoll] = createSignal(1);
  const draws = createMemo(() => {
    const r = settledActive();
    const index = nav();
    if (!simulating() || !r || !index) return [];
    return simulate(r, index, SIM_DRAWS, seeded(`${r.name}:${roll()}`));
  });
  createEffect(() => {
    const list = draws();
    if (!list.length) return;
    const positions: number[] = [], colours: number[] = [];
    for (const d of list) {
      const [x, y, z] = d.ok ? d.snapped : d.at;
      positions.push(x, y - 0.3, z);
      colours.push(...(d.ok ? [0.25, 0.95, 0.55] : [1, 0.3, 0.3]));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colours), 3));
    const material = spawnMaterial();
    (material.uniforms.pointSize as { value: number; }).value = 7;
    // Transparent like the roam points, or three.js draws it before them and they cover it.
    material.transparent = true;
    const points = new THREE.Points(geo, material);
    points.renderOrder = 6;
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geo.dispose();
      material.dispose();
    });
  });
  // The roam points step aside while the simulation is up: hundreds of trail dots bury it.
  createEffect(() => {
    const on = simulating() && !!active();
    if (roamPoints) roamPoints.visible = !on;
    onCleanup(() => roamPoints && (roamPoints.visible = true));
  });
  const simSummary = () => {
    const list = draws();
    const kept = list.filter(d => d.ok).length;
    const why: Record<string, number> = {};
    for (const d of list) if ("why" in d) why[d.why] = (why[d.why] ?? 0) + 1;
    return { total: list.length, kept, why: Object.entries(why).sort((a, b) => b[1] - a[1]) };
  };

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
    const lit = act ? new THREE.Color().setHSL((hueOf(act) + 0.5) % 1, 1, 0.65) : dim;
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
          // Cased like a road on a map, dark and wide under the colour, so the outline reads over
          // ground of any colour, its own included.
          for (const [hex, width, order] of [[0x0b0b12, 7, 3], [color.getHex(), 3, 4]] as const) {
            const geo = new LineGeometry();
            geo.setPositions(pts);
            const mat = materialFor(`outline:${hex}:${width}`, () => new LineMaterial({ color: hex, linewidth: width, depthTest: false }));
            mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
            activeLineMaterials.push(mat);
            const line = new Line2(geo, mat);
            line.renderOrder = order;
            overlay.add(line);
          }
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
        // Wide lines are sized in pixels, so they follow the canvas. The cached materials cover
        // every carve and plan preview, each once, however often those are redrawn.
        const w = canvasElement.clientWidth, h = canvasElement.clientHeight;
        for (const m of activeLineMaterials) m.resolution.set(w, h);
        for (const m of overlayMaterials.values()) if (m instanceof LineMaterial) m.resolution.set(w, h);
        stalkMaterial.resolution.set(w, h);
        stepReplay(dt);
        flashFrame(canvasElement.clientWidth, canvasElement.clientHeight);
        if (glow) {
          const beat = 0.5 + 0.5 * Math.sin(performance.now() / 260);
          glow.linewidth = 3 + 4 * beat;
          glow.opacity = 0.55 + 0.45 * beat;
          glow.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        }
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
        // Below three corners an outline is no shape at all, and below two points a route goes nowhere.
        const path = activePath();
        if (path && path.legs.length <= 2) return flash("a route needs two points; drop the route instead", "warn");
        if (!path && handle.ring === 0 && (active()?.rings[0]?.length ?? 0) <= 3) {
          return flash("an outline needs three corners; delete the region instead", "warn");
        }
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
      // Reviewing: the camera, hovering and selection all still work; nothing moves under them. Nor
      // while holes are being cut, for the reason undo waits.
      if (!canEdit() || cutting()) return;
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
      setDragging(true);
      controls!.enabled = false;
      ev.preventDefault();
    };

    const onMouseMove = (ev: MouseEvent) => {
      aim(ev);
      const ground = groundPoint();
      setCursor(ground);
      // With nothing selected, the region under the cursor is the one a click would pick.
      if (!drag && !spawnDrag && mode() === "select" && !active()) {
        const p = ground;
        const name = p ? regionAt(asSet(regions()), p.x, p.z, p.y) : null;
        setHoverRegion(name);
        canvasElement.style.cursor = name ? "pointer" : "";
      } else if (hoverRegion()) {
        setHoverRegion(null);
        canvasElement.style.cursor = "";
      }
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
      if (!target) return flash(act ? `drop it inside ${act.name} to assign it there` : "drop it inside a region to assign it", "warn");
      checkpoint(`assign ${spawn.name} to ${target}`);
      setAssign(a => ({ ...a, [spawn.id]: [target] }));
      // Said, since with "hide mobs that have a region" ticked the dot just disappears.
      flash(`assigned ${spawn.name} to ${target}`);
    };

    const onMouseUp = (ev: MouseEvent) => {
      endSpawnDrag(ev);
      // Pressed on a corner and let go without moving it: nothing changed, so no step either.
      if (drag && !drag.inserted && !drag.moved) forget();
      drag = null;
      setDragging(false);
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
        else if (simulating()) setSimulating(false);
        else if (t.kind === "carve") setMode("select");
        else if (replayId()) setReplayId(null);
        else if (walker()) editWalker(null);
        else setActiveName(null);
        return;
      }
      finishDraw();
    };

    // A tooltip for what was under the pointer goes when the pointer leaves the map.
    const onMouseLeave = () => {
      setHoleHover(null);
      if (!spawnDrag) setHover(null);
    };
    canvasElement.addEventListener("mousedown", onMouseDown);
    canvasElement.addEventListener("mousemove", onMouseMove);
    canvasElement.addEventListener("mouseleave", onMouseLeave);
    // On the window, so letting go off the map still ends a drag rather than leaving it stuck on.
    window.addEventListener("mouseup", onMouseUp);
    canvasElement.addEventListener("click", onClick);
    canvasElement.addEventListener("contextmenu", onContextMenu);
    const onAnyClick = (ev: MouseEvent) => {
      if (!menuElement?.contains(ev.target as Node)) setMenu(null);
    };
    window.addEventListener("click", onAnyClick);
    window.addEventListener("keydown", onKeyDown);

    // The scene's flip only reaches world matrices on the first render, which has not happened yet;
    // measured before it, the spawns' box came out mirrored and a zone opened off to one side.
    scene().updateMatrixWorld(true);
    // The regions as well as the spawns: fitted to the spawns alone, outlines past them were cut off.
    fitCameraToContents(camera(), controls, fn => {
      if (spawnPoints) fn(spawnPoints);
      fn(overlay);
    });

    // For scripts that drive the editor in a browser (scripts/howto): where things are on screen,
    // and what the editor holds. The dev server only; a build carries none of it.
    if (import.meta.env.DEV) {
      (window as any).__regionEditor = {
        /** Screen position, in page pixels, of a zone point. */
        project: (x: number, y: number, z: number) => {
          const v = new THREE.Vector3(x, -y, -z).project(camera());
          const rect = canvasElement.getBoundingClientRect();
          return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height, onScreen: v.z < 1 };
        },
        regions: () => regions(),
        active: () => activeName(),
        assign: () => assign(),
        spawns: () => props.spawns,
        coverage: () => coverage(),
        /** Glides to frame a zone point from a distance, keeping the view angle. */
        look: (x: number, y: number, z: number, distance = 60, ms = 1200) =>
          new Promise<void>(done => {
            const dir = new THREE.Vector3().subVectors(camera().position, controls!.target).normalize();
            const fromTarget = controls!.target.clone(), fromPos = camera().position.clone();
            const toTarget = new THREE.Vector3(x, -y, -z);
            const toPos = toTarget.clone().addScaledVector(dir, distance);
            const start = performance.now();
            const step = () => {
              const t = Math.min(1, (performance.now() - start) / ms), e = t * t * (3 - 2 * t);
              controls!.target.lerpVectors(fromTarget, toTarget, e);
              camera().position.lerpVectors(fromPos, toPos, e);
              controls!.update();
              if (t < 1) requestAnimationFrame(step);
              else done();
            };
            step();
          }),
        trail: (id: string) => trailPoints([id]),
        floorAt: (x: number, y: number, z: number) => floorIndex?.at(x, y, z) ?? null,
        paths: () => paths(),
      };
      onCleanup(() => delete (window as any).__regionEditor);
    }

    // A shared link opens where it was taken, over the default framing.
    const opened = props.view;
    if (opened?.camera?.length === 6 && opened.camera.every(Number.isFinite)) {
      controls.target.set(opened.camera[0], opened.camera[1], opened.camera[2]);
      camera().position.set(opened.camera[3], opened.camera[4], opened.camera[5]);
      controls.update();
    }
    if (opened?.floor !== undefined && floors().includes(opened.floor)) setFloor(opened.floor);
    if (opened?.region && regions().some(r => r.name === opened.region)) setActiveName(opened.region);

    // Reported once it stops moving: a drag changes the camera every frame.
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    const reportView = () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        const t = controls!.target, p = camera().position;
        // The scene is mirrored on y and z, so the target in zone coordinates is (x, -y, -z).
        setViewGround({ floor: floorIndex?.at(t.x, -t.y, -t.z) ?? null, y: -t.y });
        props.onView?.({
          camera: [t.x, t.y, t.z, p.x, p.y, p.z].map(n => Math.round(n * 10) / 10),
          region: untrack(activeName) ?? undefined,
          floor: untrack(floor) ?? undefined,
        });
      }, 400);
    };
    controls.addEventListener("change", reportView);
    createEffect(on([activeName, floor], reportView, { defer: true }));
    onCleanup(() => {
      clearTimeout(viewTimer);
      controls?.removeEventListener("change", reportView);
    });

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
      for (const label of featureLabels()) {
        const el = featureLabelRefs.get(label.key);
        if (el) place(el, label.at);
      }
      const g = grid();
      if (g) {
        // The headers sit on the bottom and right edges of the view, like the frame of the game's map
        // (the top and left are the toolbar's), each slid
        // along to where its column or row crosses the middle of the view.
        const y = viewGround()?.y ?? 0;
        const t = controls!.target;
        const w = canvasElement.clientWidth, h = canvasElement.clientHeight;
        const toScreen = (x: number, z: number) => {
          const v = new THREE.Vector3(x, -y, -z).project(camera());
          return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 };
        };
        for (const col of g.columns) {
          const el = gridHeaderRefs.get(`c${col.name}`);
          const p = toScreen(col.x, -t.z);
          const show = p.ok && p.x > 10 && p.x < w - 30;
          if (el) (el.style.display = show ? "block" : "none", show && (el.style.transform = `translate(-50%, 0) translate(${p.x}px, 0)`));
        }
        for (const row of g.rows) {
          const el = gridHeaderRefs.get(`r${row.name}`);
          const p = toScreen(t.x, row.z);
          const show = p.ok && p.y > 40 && p.y < h - 30;
          if (el) (el.style.display = show ? "block" : "none", show && (el.style.transform = `translate(0, -50%) translate(0, ${p.y}px)`));
        }
      }
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
      canvasElement.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("mouseup", onMouseUp);
      canvasElement.removeEventListener("click", onClick);
      canvasElement.removeEventListener("contextmenu", onContextMenu);
      viewer.dispose();
    });
  });

  /** Grows a hole from its middle over the ground no member mob was recorded on. */
  const growFromHole = (name: string, index: number) => {
    const ring = regions().find(r => r.name === name)?.rings[index];
    if (!ring?.length) return;
    const x = ring.reduce((t, v) => t + v[0], 0) / ring.length;
    const z = ring.reduce((t, v) => t + v[2], 0) / ring.length;
    setGrow({ name, x, z, y: ring[0][1] });
  };

  const toggleReplay = (id: string) => {
    if (replayId() === id) return setReplayId(null);
    if (trailPoints([id]).length < 2) return flash(`no roam trail for ${props.spawns.find(s => s.id === id)?.name ?? id}`, "warn");
    setReplayId(id);
  };

  const assignToActive = (spawn: Spawn) => {
    const name = activeName();
    if (!name) return;
    checkpoint(`assign ${spawn.name} to ${name}`);
    setAssign(a => ({ ...a, [spawn.id]: [name] }));
  };

  /** Drops a route and every mob walking it with the lead, as one step. */
  const dropRouteGroup = (ids: string[]) => {
    checkpoint(`drop the route for ${mobs(ids.length)}`);
    setPaths(all => {
      const next = { ...all };
      for (const id of ids) delete next[id];
      return next;
    });
    if (ids.includes(walker() ?? "")) editWalker(null);
    flash(`dropped the route for ${mobs(ids.length)}`);
  };

  const menuActions: MenuActions = {
    canEdit,
    close: () => setMenu(null),
    mobsIn: name => props.spawns.filter(s => assign()[s.id]?.includes(name)).length,
    toRoute: convertToPatrol,
    repair: repairShape,
    centre: centerOn,
    deleteRegion,
    holeArea: (name, index) => Math.abs(signedArea(regions().find(r => r.name === name)?.rings[index] ?? [])),
    nearHoles: (name, index) => {
      const r = regions().find(x => x.name === name);
      return r ? nearHoles(r, index, mergeReach()).length : 0;
    },
    mergeReach,
    merge: (name, index) => setMerge({ name, index }),
    grow: growFromHole,
    deleteHole,
    holeFromRoam: (name, x, z) => setGrow({ name, x, z, y: lastYOf(name, x, z) }),
    traceRoute: startPath,
    replaying: id => replayId() === id,
    toggleReplay,
    assignTarget: activeName,
    assign: assignToActive,
    flyTo: s => flyTo(s.x, s.y, s.z),
    group: lead => routeGroups().find(g => g.lead === lead),
    nameOf: id => props.spawns.find(s => s.id === id)?.name ?? id,
    editLegs: selectRoute,
    retrace,
    dropRoute: dropRouteGroup,
  };

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
          <For each={featureLabels()}>
            {label => {
              onCleanup(() => featureLabelRefs.delete(label.key));
              return (
                <div
                  ref={el => featureLabelRefs.set(label.key, el)}
                  class="absolute left-0 top-0 text-xs font-bold whitespace-nowrap select-none bg-slate-900/70 rounded px-1 leading-tight"
                  style={{ display: "none" }}
                >
                  <For each={label.lines}>{line => <div class={line.tone}>{line.text}</div>}</For>
                </div>
              );
            }}
          </For>
          <Show when={grid()}>
            {g => (
              <>
                <div class="absolute left-0 right-0 bottom-0 h-6 bg-slate-900/60" />
                <div class="absolute top-0 bottom-0 right-0 w-7 bg-slate-900/60" />
                <For each={g().columns}>
                  {col => {
                    onCleanup(() => gridHeaderRefs.delete(`c${col.name}`));
                    return (
                      <div
                        ref={el => gridHeaderRefs.set(`c${col.name}`, el)}
                        class="absolute left-0 bottom-1 text-xs font-bold text-amber-200 select-none"
                        style={{ display: "none" }}
                      >
                        {col.name}
                      </div>
                    );
                  }}
                </For>
                <For each={g().rows}>
                  {row => {
                    onCleanup(() => gridHeaderRefs.delete(`r${row.name}`));
                    return (
                      <div
                        ref={el => gridHeaderRefs.set(`r${row.name}`, el)}
                        class="absolute top-0 right-0 w-7 text-center text-xs font-bold text-amber-200 select-none"
                        style={{ display: "none" }}
                      >
                        {row.name}
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </Show>
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
          <div class="absolute top-2 right-10 text-xs text-slate-200 bg-slate-900/85 rounded px-3 py-1.5 pointer-events-none text-right">
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
        <MapToolbar
          readOnly={props.readOnly}
          selected={!!active()}
          carving={mode() === "obstacles"}
          canGround={!!zoneMesh}
          onCarve={() => setMode(m => (m === "obstacles" ? "select" : "obstacles"))}
          onSimplify={simplifyActive}
          onGround={groundActive}
          simulating={simulating()}
          onSimulate={() => setSimulating(on => !on)}
          sheet={showSheet()}
          onSheet={() => setShowSheet(on => !on)}
          zoneInfo={showZoneInfo()}
          zoneInfoNote={props.features
            ? `${props.features.triggers.areas.length} trigger areas, ${props.features.lines.length} zone lines out and ${props.features.arrivals.length} in${
              props.features.triggers.computed ? `; ${props.features.triggers.computed} trigger areas are worked out by the script and not shown` : ""
            }`
            : "Loading the zone's server files…"}
          onZoneInfo={() => setShowZoneInfo(on => !on)}
        />
        <Show when={simulating() && active()}>
          <div class="absolute top-11 left-2 z-20 w-72 text-xs bg-slate-900/90 rounded px-3 py-2 space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-[10px] uppercase tracking-wide text-slate-500">Simulated spawns</span>
              <button class="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600" disabled={!nav()} onClick={() => setRoll(n => n + 1)}>
                Draw again
              </button>
            </div>
            <Show
              when={nav()}
              fallback={<div class="text-slate-400">{navIndex.error ? "No navmesh for this zone, so every draw would stand." : "Loading the navmesh…"}</div>}
            >
              <div class="text-slate-300">
                <b class="text-emerald-400">{simSummary().kept}</b> of {simSummary().total} draws kept
              </div>
              <For each={simSummary().why}>
                {([why, n]) => (
                  <div class="text-red-300">
                    {n} thrown away: {why}
                  </div>
                )}
              </For>
              <div class="text-slate-500 leading-snug">
                Green is where the server would put a mob, red a draw it throws away and draws again: off the navmesh by more than {SNAP_TOLERANCE}{" "}
                yalms, or snapped out of the region.
              </div>
            </Show>
          </div>
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
        <Show when={cursor()}>{at => <CursorReadout at={at()} grid={gridAt(at().x, at().y, at().z)} raised={!!grid()} />}</Show>
        <Show when={menu()}>
          {target => <EditorMenu target={target()} ref={el => (menuElement = el)} actions={menuActions} />}
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
              <Show when={gridAt(hover()!.spawn.x, hover()!.spawn.y, hover()!.spawn.z)}>{g => <span class="text-amber-300 ml-1">({g()})</span>}</Show>
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
            inside={insideActive().filter(s => assign()[s.id]?.join() !== activeName()).length}
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
