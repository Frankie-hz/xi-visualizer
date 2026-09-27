import * as THREE from "three";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MapControls } from "three/examples/jsm/Addons.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { createMapCamera } from "../graphics/camera";
import { buildNavMeshGroup, parseNavMesh } from "../graphics/navmesh";
import { createMobLayer, createNodeLayer, type MobView } from "../graphics/path_nodes";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { createViewer } from "../graphics/viewer";
import { ColorKind, createZoneMesh, prepareMeshData } from "../graphics/ximesh";
import { arrivalRays, type Extraction, matchRays, type Node, type PathData } from "../path_nodes/extract";
import type { Generated } from "../path_nodes/generate";
import type { WorkerMessage, WorkerRequest } from "../path_nodes/worker";
import { ZoneData } from "./zone_model";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface PathNodesViewerProps {
  zoneData: ZoneData;
  /** Recorded roam trails; empty for a zone nobody captured. */
  pathData: PathData;
  /** The gzipped roam file as downloaded, if there is one; a copy is handed to the extraction worker. */
  compressed?: ArrayBuffer;
  /** The server's navmesh, if there is one: lets the gap filler cover ground nobody recorded. */
  nav?: ArrayBuffer;
}

interface MobEntry {
  id: string;
  name: string;
  nodes: number;
}

const EXPORT_VERSION = 1;
/** Zone mesh surface type for deep water (low nibble of each triangle's meta word). */
const DEEP_WATER = 9;

/** The zone mesh's deep-water triangles as flat xyz, three vertices each. */
function waterTriangles(mesh: THREE.Mesh): Float32Array {
  const positions = mesh.geometry.getAttribute("position");
  const meta = mesh.geometry.getAttribute("meta");
  const index = mesh.geometry.index;
  const out: number[] = [];
  if (!index || !meta) return new Float32Array();
  for (let t = 0; t < index.count / 3; t++) {
    const first = index.getX(t * 3);
    if ((meta.array[first * meta.itemSize + 5] & 0xf) !== DEEP_WATER) continue;
    for (let k = 0; k < 3; k++) {
      const v = index.getX(t * 3 + k);
      out.push(positions.getX(v), positions.getY(v), positions.getZ(v));
    }
  }
  return Float32Array.from(out);
}
/** Share of the screen the framed contents may fill, and the smallest area framed so a single node is not filled edge to edge. */
const FRAME_FILL = 0.85;
const FRAME_MIN_HALF = 20;
const FRAME_PASSES = 4;

/**
 * Points the overhead camera at raw FFXI coordinates and backs it off until the contents' corners fit the canvas.
 * The camera sits outside the flipped scene, so everything handed to it is flipped by hand (see src/graphics/README.md).
 */
function frameRaw(
  camera: THREE.PerspectiveCamera,
  controls: MapControls,
  canvas: HTMLCanvasElement,
  points: { x: number; y: number; z: number }[],
) {
  if (points.length === 0) return;
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of points) {
    const world = new THREE.Vector3(p.x, -p.y, -p.z);
    min.min(world);
    max.max(world);
  }
  const center = min.clone().add(max).multiplyScalar(0.5);
  min.x = Math.min(min.x, center.x - FRAME_MIN_HALF);
  max.x = Math.max(max.x, center.x + FRAME_MIN_HALF);
  min.z = Math.min(min.z, center.z - FRAME_MIN_HALF);
  max.z = Math.max(max.z, center.z + FRAME_MIN_HALF);
  const corners: THREE.Vector3[] = [];
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z));
    }
  }
  const target = new THREE.Vector3(center.x, max.y, center.z);
  let distance = Math.max(max.x - min.x, max.z - min.z);
  for (let pass = 0; pass < FRAME_PASSES; pass++) {
    camera.position.set(target.x, target.y + distance, target.z);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const reach = corners.reduce((m, c) => {
      const ndc = c.clone().project(camera);
      return Math.max(m, Math.abs(ndc.x), Math.abs(ndc.y));
    }, 0);
    distance *= reach / FRAME_FILL;
  }
  camera.position.set(target.x, target.y + distance, target.z);
  controls.target.copy(target);
  camera.lookAt(target);
  controls.update();
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PathNodesViewer(props: PathNodesViewerProps) {
  let canvasElement: HTMLCanvasElement;
  /** Contents waiting to be framed; applied on the first frame the canvas has a size, since a background tab measures 0x0. */
  let pendingFrame: { x: number; y: number; z: number }[] | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => createMapCamera());
  const nodeLayer = createNodeLayer();
  const mobLayer = createMobLayer();

  const [progress, setProgress] = createSignal("Starting");
  const [error, setError] = createSignal<string | undefined>();
  const [result, setResult] = createSignal<Extraction | undefined>();
  const [generated, setGenerated] = createSignal<Generated>({ nodes: [], edges: [] });
  const [minMobs, setMinMobs] = createSignal(2);
  const [minEdgeCount, setMinEdgeCount] = createSignal(3);
  const [showRings, setShowRings] = createSignal(true);
  const [showEdges, setShowEdges] = createSignal(true);
  const [showSamples, setShowSamples] = createSignal(true);
  const [showRecordedFill, setShowRecordedFill] = createSignal(true);
  const [showNavmeshFill, setShowNavmeshFill] = createSignal(true);
  const fillCounts = createMemo(() => {
    const nodes = generated().nodes;
    const navmesh = nodes.filter(n => n.ground === "navmesh").length;
    return { recorded: nodes.length - navmesh, navmesh };
  });
  const [showNav, setShowNav] = createSignal(false);
  const [mobFilter, setMobFilter] = createSignal("");
  const [selectedMob, setSelectedMob] = createSignal<string | undefined>();
  const [hovered, setHovered] = createSignal<{ node: Node; x: number; y: number } | undefined>();

  const nodeById = createMemo(() => new Map([...(result()?.nodes ?? []), ...generated().nodes].map(n => [n.id, n])));

  const visibleCounts = createMemo(() => {
    const r = result();
    if (!r) return { nodes: 0, edges: 0 };
    const shown = new Set(r.nodes.filter(n => n.mobs >= minMobs()).map(n => n.id));
    const edges = r.edges.filter(e => e.count >= minEdgeCount() && shown.has(e.a) && shown.has(e.b));
    return { nodes: shown.size, edges: edges.length };
  });

  const mobEntries = createMemo<MobEntry[]>(() => {
    const r = result();
    if (!r) return [];
    return Object.entries(r.mobs)
      .map(([id, m]) => ({ id, name: m.name, nodes: m.nodes.length }))
      .sort((a, b) => parseInt(a.id) - parseInt(b.id));
  });

  const filteredMobs = createMemo(() => {
    const filter = mobFilter().toLowerCase();
    if (!filter) return mobEntries();
    return mobEntries().filter(m => m.name.toLowerCase().includes(filter) || m.id.includes(filter));
  });

  const mobView = createMemo<MobView | undefined>(() => {
    const id = selectedMob();
    const r = result();
    if (!id || !r?.mobs[id]) return undefined;
    const points = props.pathData[id].points;
    const rays = arrivalRays(points);
    const mob = r.mobs[id];
    return {
      points,
      rays,
      matched: matchRays(rays, mob.nodes),
      nodes: mob.nodes,
      heights: mob.nodeIds.map(nodeId => nodeById().get(nodeId)?.y ?? 0),
    };
  });

  const mobStats = createMemo(() => {
    const view = mobView();
    if (!view) return undefined;
    const matched = view.matched.filter(m => m >= 0).length;
    return { rays: view.rays.length, matched, nodes: view.nodes.length };
  });

  const zoneMesh = createMemo(() => {
    const prep = prepareMeshData(props.zoneData.mesh);
    const mesh = createZoneMesh(props.zoneData.id, props.zoneData.mesh, prep, ColorKind.Materials);
    scene().add(mesh);
    onCleanup(() => {
      scene().remove(mesh);
      cleanupNode(mesh);
    });
    return mesh;
  });

  const parsedNav = createMemo(() => {
    if (!props.nav) return undefined;
    return parseNavMesh(props.nav);
  });

  // The navmesh stands in for the terrain while it is shown: both at once is unreadable.
  createEffect(() => {
    const nav = parsedNav();
    const shown = showNav() && nav !== undefined;
    zoneMesh().visible = !shown;
    if (!shown) return;
    const group = buildNavMeshGroup(nav, {
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

  const samples = createMemo(() => {
    const positions: number[] = [];
    for (const mob of Object.values(props.pathData)) {
      for (const p of mob.points) positions.push(p.x, p.y, p.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x94a3b8,
      size: 2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
    });
    const points = new THREE.Points(geometry, material);
    scene().add(points);
    onCleanup(() => {
      scene().remove(points);
      geometry.dispose();
      material.dispose();
    });
    return points;
  });

  createEffect(() => {
    samples().visible = showSamples() && !selectedMob();
  });

  scene().add(nodeLayer.group);
  scene().add(mobLayer.group);

  createEffect(() => {
    const r = result();
    if (!r) return;
    nodeLayer.update({
      nodes: r.nodes,
      edges: r.edges,
      generatedNodes: generated().nodes,
      generatedEdges: generated().edges,
      minMobs: minMobs(),
      minEdgeCount: minEdgeCount(),
      showRings: showRings(),
      showEdges: showEdges(),
      showRecordedFill: showRecordedFill(),
      showNavmeshFill: showNavmeshFill(),
    });
  });

  createEffect(() => {
    const view = mobView();
    mobLayer.update(view);
    if (view) {
      pendingFrame = view.points;
      return;
    }
    const r = result();
    if (r) pendingFrame = [...r.nodes, ...generated().nodes];
  });

  const exportNodes = () => {
    const r = result();
    if (!r) return;
    const nodes = r.nodes.filter(n => n.mobs >= minMobs());
    const shown = new Set(nodes.map(n => n.id));
    const edges = r.edges.filter(e => e.count >= minEdgeCount() && shown.has(e.a) && shown.has(e.b));
    const fill = generated().nodes.filter(n => {
      if (n.ground === "navmesh") return showNavmeshFill();
      return showRecordedFill();
    });
    nodes.push(...fill);
    for (const n of fill) shown.add(n.id);
    edges.push(...generated().edges.filter(e => shown.has(e.a) && shown.has(e.b)));
    const payload = {
      version: EXPORT_VERSION,
      zone: { id: props.zoneData.id, name: props.zoneData.name },
      thresholds: { minMobs: minMobs(), minEdgeCount: minEdgeCount() },
      nodes: nodes.map(({ id, x, y, z, r, mobs, generated, ground }) => ({
        id,
        x,
        y,
        z,
        r,
        mobs,
        generated: generated === true,
        ground: ground ?? null,
      })),
      edges: edges.map(({ a, b, count, generated }) => ({ a, b, count, generated: generated === true })),
    };
    download(`${props.zoneData.name.replaceAll(" ", "_")}_path_nodes.json`, JSON.stringify(payload, null, 1));
  };

  onMount(() => {
    const viewer = createViewer(canvasElement, {
      scene: scene(),
      camera: camera(),
      onFrame: () => {
        if (!pendingFrame || canvasElement.clientWidth === 0 || canvasElement.clientHeight === 0) return;
        frameRaw(camera(), viewer.controls, canvasElement, pendingFrame);
        pendingFrame = undefined;
      },
    });

    const worker = new Worker(new URL("../path_nodes/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        const pct = Math.round((message.done / Math.max(1, message.total)) * 100);
        setProgress(`${message.stage} ${pct}%`);
        return;
      }
      if (message.type === "error") {
        setError(message.message);
        return;
      }
      setGenerated(message.generated);
      setResult(message.result);
    };
    const compressed = props.compressed?.slice(0);
    const nav = props.nav?.slice(0);
    const water = waterTriangles(zoneMesh()).buffer as ArrayBuffer;
    const transfer = [compressed, nav, water].filter((b): b is ArrayBuffer => b !== undefined);
    worker.postMessage({ compressed, nav, water } satisfies WorkerRequest, transfer);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.5 };
    const mouse = new THREE.Vector2();
    const castAt = (event: MouseEvent) => {
      const rect = canvasElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera());
      const id = nodeLayer.pick(raycaster);
      if (id === undefined) return undefined;
      return nodeById().get(id);
    };
    const onMouseMove = (event: MouseEvent) => {
      const node = castAt(event);
      if (!node) {
        setHovered(undefined);
        return;
      }
      setHovered({ node, x: event.clientX, y: event.clientY });
    };
    canvasElement.addEventListener("mousemove", onMouseMove);

    onCleanup(() => {
      canvasElement.removeEventListener("mousemove", onMouseMove);
      worker.terminate();
      nodeLayer.dispose();
      mobLayer.dispose();
      viewer.dispose();
    });
  });

  return (
    <div class="flex gap-4" style={{ height: "75vh" }}>
      <div class="flex-1 relative">
        <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
        <Show when={!result() && !error()}>
          <div class="absolute top-2 left-2 px-2 py-1 bg-slate-900/80 rounded text-sm">{progress()}</div>
        </Show>
        <Show when={error()}>
          <div class="absolute top-2 left-2 px-2 py-1 bg-red-900/80 rounded text-sm">Extraction failed: {error()}</div>
        </Show>
        <Show when={hovered()}>
          <div
            class="fixed bg-slate-900 text-white px-2 py-1 rounded text-sm pointer-events-none z-50"
            style={{ left: `${hovered()!.x + 10}px`, top: `${hovered()!.y + 10}px` }}
          >
            <div class="font-bold">Node {hovered()!.node.id}</div>
            <div class="text-slate-400 text-xs">
              {hovered()!.node.x.toFixed(2)}, {hovered()!.node.y.toFixed(2)}, {hovered()!.node.z.toFixed(2)}
            </div>
            <Show
              when={!hovered()!.node.generated}
              fallback={
                <Show
                  when={hovered()!.node.ground === "navmesh"}
                  fallback={<div class="text-cyan-300 text-xs">radius {hovered()!.node.r.toFixed(2)}, generated to fill a gap where mobs were recorded</div>}
                >
                  <div class="text-lime-300 text-xs">radius {hovered()!.node.r.toFixed(2)}, generated from the navmesh: no mob was recorded here</div>
                </Show>
              }
            >
              <div class="text-slate-400 text-xs">radius {hovered()!.node.r.toFixed(2)}, walked by {hovered()!.node.mobs} mobs</div>
              <div class="text-slate-400 text-xs max-w-64">{hovered()!.node.species.join(", ")}</div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="w-72 flex flex-col gap-2 bg-slate-800 rounded-lg p-2 overflow-hidden text-sm">
        <Show when={result()} fallback={<div class="text-slate-400">Extracting nodes in the background...</div>}>
          <div class="text-xs text-slate-400">
            Showing {visibleCounts().nodes} of {result()!.nodes.length} nodes, {visibleCounts().edges} edges.{" "}
            {Object.keys(result()!.mobs).length} mobs contributed {result()!.arrivals} arrivals.{" "}
            <span class="text-cyan-300">{fillCounts().recorded} nodes generated in gaps where mobs were recorded,</span>{" "}
            <span class="text-lime-300">{fillCounts().navmesh} from the navmesh where none were.</span>
          </div>

          <label class="flex flex-col text-xs">
            Node walked by at least {minMobs()} mob(s)
            <input type="range" min="1" max="6" value={minMobs()} onInput={e => setMinMobs(parseInt(e.currentTarget.value))} />
          </label>
          <label class="flex flex-col text-xs">
            Edge walked at least {minEdgeCount()} time(s)
            <input type="range" min="1" max="20" value={minEdgeCount()} onInput={e => setMinEdgeCount(parseInt(e.currentTarget.value))} />
          </label>
          <div class="flex flex-wrap gap-x-3 text-xs">
            <label><input type="checkbox" checked={showRings()} onChange={e => setShowRings(e.currentTarget.checked)} /> Radius rings</label>
            <label><input type="checkbox" checked={showEdges()} onChange={e => setShowEdges(e.currentTarget.checked)} /> Edges</label>
            <label><input type="checkbox" checked={showSamples()} onChange={e => setShowSamples(e.currentTarget.checked)} /> Roam samples</label>
            <Show when={props.nav}>
              <label><input type="checkbox" checked={showNav()} onChange={e => setShowNav(e.currentTarget.checked)} /> Navmesh</label>
            </Show>
            <label class="text-cyan-300">
              <input type="checkbox" checked={showRecordedFill()} onChange={e => setShowRecordedFill(e.currentTarget.checked)} /> Gap fill
            </label>
            <label class="text-lime-300">
              <input type="checkbox" checked={showNavmeshFill()} onChange={e => setShowNavmeshFill(e.currentTarget.checked)} /> Navmesh fill
            </label>
          </div>
          <button class="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs" onClick={exportNodes}>
            Export shown nodes as JSON
          </button>

          <div class="border-t border-slate-700 pt-2 text-xs text-slate-400">
            Pick a mob to see how its nodes were found: every straight leg (grey) that ends in a turn runs on (yellow) to the
            center of the node it was walking to.
          </div>
          <Show when={selectedMob() && mobStats()}>
            <div class="bg-slate-900 rounded p-2 text-xs">
              <div class="font-bold">
                {result()!.mobs[selectedMob()!].name} {selectedMob()}
              </div>
              <div class="text-slate-400">
                {mobStats()!.nodes} nodes, {mobStats()!.matched} of {mobStats()!.rays} legs aimed at one
              </div>
              <div class="text-slate-400">
                aim offset {result()!.mobs[selectedMob()!].offset.map(v => v.toFixed(2)).join(", ")}
              </div>
              <button class="mt-1 px-2 py-0.5 bg-slate-600 hover:bg-slate-500 rounded" onClick={() => setSelectedMob(undefined)}>
                Back to all nodes
              </button>
            </div>
          </Show>
          <input
            type="text"
            placeholder="Filter mobs..."
            class="w-full px-2 py-1 bg-slate-700 rounded text-sm"
            value={mobFilter()}
            onInput={e => setMobFilter(e.currentTarget.value)}
          />
          <div class="flex-1 overflow-y-auto">
            <For each={filteredMobs()}>
              {mob => (
                <div
                  class="flex items-center gap-2 py-1 px-1 hover:bg-slate-700 rounded cursor-pointer"
                  classList={{ "bg-slate-700": selectedMob() === mob.id }}
                  onClick={() => setSelectedMob(mob.id)}
                >
                  <div class="flex-1 min-w-0">
                    <div class="truncate" title={mob.name}>{mob.name}</div>
                    <div class="text-xs text-slate-500">{mob.id}</div>
                  </div>
                  <span class="text-xs text-slate-500">{mob.nodes} nodes</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
