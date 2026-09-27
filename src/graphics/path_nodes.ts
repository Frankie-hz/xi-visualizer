import * as THREE from "three";
import type { Edge, MobNode, Node, PathPoint, Ray } from "../path_nodes/extract";

const RING_SEGMENTS = 40;
const LEG_GAP = 20;
const OVERLAY_ORDER = 10;

export interface NodeView {
  nodes: Node[];
  edges: Edge[];
  /** Nodes and links the gap filler placed where no node could be extracted. */
  generatedNodes: Node[];
  generatedEdges: Edge[];
  minMobs: number;
  minEdgeCount: number;
  showRings: boolean;
  showEdges: boolean;
  /** Generated nodes filling gaps where mobs were recorded. */
  showRecordedFill: boolean;
  /** Generated nodes on ground no mob was recorded on, placed from the navmesh alone. */
  showNavmeshFill: boolean;
}

export interface MobView {
  points: PathPoint[];
  rays: Ray[];
  /** Index into `nodes` of the node each ray was walking to, or -1. */
  matched: number[];
  nodes: MobNode[];
  /** Height to draw each of `nodes` at. */
  heights: number[];
}

function overlayLines(color: number, opacity: number, vertexColors = false) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, vertexColors });
}

function overlayPoints(color: number, size: number) {
  return new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true });
}

/** Round dots with a dark rim, so they read on sand, grass, water and rock alike. */
function outlinedPoints(color: number, size: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      fill: { value: new THREE.Color(color) },
      size: { value: size },
    },
    vertexShader: `
      uniform float size;
      void main() {
        gl_PointSize = size;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 fill;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = vec4(fill, 1.0);
        if (d > 0.3) gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      }
    `,
    transparent: true,
    depthTest: false,
  });
}

function ringSegments(out: number[], x: number, y: number, z: number, r: number) {
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a0 = (i / RING_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
    out.push(x + r * Math.cos(a0), y, z + r * Math.sin(a0), x + r * Math.cos(a1), y, z + r * Math.sin(a1));
  }
}

/** Removes and frees the geometry of every child; the materials are shared and outlive a rebuild. */
function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    (child as THREE.LineSegments | THREE.Points).geometry.dispose();
  }
}

function lineObject(positions: number[], material: THREE.Material, colors?: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = OVERLAY_ORDER;
  lines.frustumCulled = false;
  return lines;
}

function pointObject(positions: number[], material: THREE.Material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const points = new THREE.Points(geometry, material);
  points.renderOrder = OVERLAY_ORDER + 1;
  points.frustumCulled = false;
  return points;
}

/** The shared node graph: radius rings, center points and edges weighted by how often mobs walked them, plus the generated fill in its own colour. */
export function createNodeLayer() {
  const group = new THREE.Group();
  const materials = {
    rings: overlayLines(0xff4040, 0.9),
    centers: outlinedPoints(0xff2bd6, 8),
    edges: overlayLines(0xffffff, 0.8, true),
    generatedRings: overlayLines(0x22d3ee, 0.9),
    generatedCenters: outlinedPoints(0x22d3ee, 8),
    generatedEdges: overlayLines(0x2dd4bf, 0.7),
    navmeshRings: overlayLines(0xa3e635, 0.9),
    navmeshCenters: outlinedPoints(0xa3e635, 8),
    navmeshEdges: overlayLines(0x84cc16, 0.7),
  };
  /** Center points and the node id behind each of their vertices, for picking. */
  let pickable: { points: THREE.Points; ids: number[] }[] = [];

  const clear = () => {
    clearGroup(group);
    pickable = [];
  };

  const addNodes = (nodes: Node[], showRings: boolean, centers: THREE.Material, rings: THREE.Material) => {
    const positions: number[] = [];
    const ringPositions: number[] = [];
    for (const n of nodes) {
      positions.push(n.x, n.y, n.z);
      if (showRings) ringSegments(ringPositions, n.x, n.y, n.z, Math.max(n.r, 0.3));
    }
    const points = pointObject(positions, centers);
    group.add(points);
    pickable.push({ points, ids: nodes.map(n => n.id) });
    if (ringPositions.length > 0) group.add(lineObject(ringPositions, rings));
  };

  const update = (view: NodeView) => {
    clear();
    const visible = new Map<number, Node>();
    for (const n of view.nodes) {
      if (n.mobs >= view.minMobs) visible.set(n.id, n);
    }
    const recordedFill = view.generatedNodes.filter(n => n.ground !== "navmesh");
    const navmeshFill = view.generatedNodes.filter(n => n.ground === "navmesh");
    if (view.showRecordedFill) {
      for (const n of recordedFill) visible.set(n.id, n);
    }
    if (view.showNavmeshFill) {
      for (const n of navmeshFill) visible.set(n.id, n);
    }

    addNodes(view.nodes.filter(n => visible.has(n.id)), view.showRings, materials.centers, materials.rings);
    if (view.showRecordedFill) addNodes(recordedFill, view.showRings, materials.generatedCenters, materials.generatedRings);
    if (view.showNavmeshFill) addNodes(navmeshFill, view.showRings, materials.navmeshCenters, materials.navmeshRings);

    if (!view.showEdges) return;
    const edgePositions: number[] = [];
    const edgeColors: number[] = [];
    const strongest = view.edges.reduce((m, e) => Math.max(m, e.count), 1);
    const dim = new THREE.Color(0x1e3a8a);
    const bright = new THREE.Color(0x60a5fa);
    const color = new THREE.Color();
    for (const e of view.edges) {
      const a = visible.get(e.a);
      const b = visible.get(e.b);
      if (!a || !b || e.count < view.minEdgeCount) continue;
      color.lerpColors(dim, bright, Math.sqrt(e.count / strongest));
      edgePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      edgeColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    if (edgePositions.length > 0) group.add(lineObject(edgePositions, materials.edges, edgeColors));

    // A generated link touching navmesh-only ground is drawn in that colour, since part of it rests on no mob data.
    const recordedLinks: number[] = [];
    const navmeshLinks: number[] = [];
    for (const e of view.generatedEdges) {
      const a = visible.get(e.a);
      const b = visible.get(e.b);
      if (!a || !b) continue;
      const target = (() => {
        if (a.ground === "navmesh" || b.ground === "navmesh") return navmeshLinks;
        return recordedLinks;
      })();
      target.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    if (recordedLinks.length > 0) group.add(lineObject(recordedLinks, materials.generatedEdges));
    if (navmeshLinks.length > 0) group.add(lineObject(navmeshLinks, materials.navmeshEdges));
  };

  /** Node id under the raycaster, if any. */
  const pick = (raycaster: THREE.Raycaster): number | undefined => {
    for (const { points, ids } of pickable) {
      const hit = raycaster.intersectObject(points)[0];
      if (hit?.index !== undefined) return ids[hit.index];
    }
    return undefined;
  };

  const dispose = () => {
    clear();
    for (const m of Object.values(materials)) m.dispose();
  };

  return { group, update, pick, dispose };
}

/** One mob, explained: its samples, the legs between them, and each leg's ray running on to the node it was aiming at. */
export function createMobLayer() {
  const group = new THREE.Group();
  const materials = {
    samples: overlayPoints(0x38bdf8, 5),
    legs: overlayLines(0x94a3b8, 0.5),
    rays: overlayLines(0xfbbf24, 0.9),
    unmatched: overlayLines(0x64748b, 0.6),
    rings: overlayLines(0xfacc15, 1),
  };

  const clear = () => clearGroup(group);

  const update = (view: MobView | undefined) => {
    clear();
    if (!view) return;

    const samples: number[] = [];
    const legs: number[] = [];
    view.points.forEach((p, i) => {
      samples.push(p.x, p.y, p.z);
      const next = view.points[i + 1];
      if (next && next.t - p.t <= LEG_GAP) legs.push(p.x, p.y, p.z, next.x, next.y, next.z);
    });

    const heightAt = new Map<number, number>();
    for (const p of view.points) heightAt.set(p.t, p.y);
    const rays: number[] = [];
    const unmatched: number[] = [];
    view.rays.forEach((r, i) => {
      const y = heightAt.get(r.t) ?? 0;
      const target = view.matched[i];
      if (target < 0) {
        unmatched.push(r.x, y, r.z, r.x + 3 * r.dx, y, r.z + 3 * r.dz);
        return;
      }
      const n = view.nodes[target];
      rays.push(r.x, y, r.z, n.x, view.heights[target], n.z);
    });

    const rings: number[] = [];
    view.nodes.forEach((n, i) => ringSegments(rings, n.x, view.heights[i], n.z, Math.max(n.r, 0.3)));

    group.add(lineObject(legs, materials.legs));
    group.add(lineObject(unmatched, materials.unmatched));
    group.add(lineObject(rays, materials.rays));
    group.add(lineObject(rings, materials.rings));
    group.add(pointObject(samples, materials.samples));
  };

  const dispose = () => {
    clear();
    for (const m of Object.values(materials)) m.dispose();
  };

  return { group, update, dispose };
}
