// Recovers retail roam nodes from recorded roam trails.
//
// A retail mob walks in a straight line at a node's center and stops once it is inside that node's
// radius, then picks the next node. So every straight leg that ends in a turn, extended forward,
// passes through the center of the node it was walking to. One mob's legs meet at each center to
// within a few hundredths of a yalm. Every mob in a zone walks the same nodes, each aiming at a
// small offset of its own, and the order it visits them gives the node graph.

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  dir: number;
  t: number;
}

export interface MobPath {
  name: string;
  points: PathPoint[];
}

export type PathData = Record<string, MobPath>;

export interface Ray {
  x: number;
  z: number;
  dx: number;
  dz: number;
  t: number;
  /** True when the heading came from the heading byte of a single sample rather than a fitted line. */
  fromHeading: boolean;
}

export interface MobNode {
  x: number;
  z: number;
  votes: number;
  resid: number;
  r: number;
}

export interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
  mobs: number;
  species: string[];
  /** Placed by the gap filler rather than recovered from roam trails. */
  generated?: boolean;
  /**
   * For a generated node, the ground it was placed on: "recorded" where mobs were seen (a gap
   * between extracted nodes), "navmesh" where no mob was ever recorded and only the navmesh says
   * the ground is walkable.
   */
  ground?: GeneratedGround;
}

export type GeneratedGround = "recorded" | "navmesh";

export interface Edge {
  a: number;
  b: number;
  count: number;
  generated?: boolean;
}

export interface MobResult {
  name: string;
  nodes: MobNode[];
  /** Consensus node id of each entry in `nodes`. */
  nodeIds: number[];
  offset: [number, number];
}

export interface Extraction {
  nodes: Node[];
  edges: Edge[];
  mobs: Record<string, MobResult>;
  arrivals: number;
}

const MAX_LEG_GAP = 20;
const SEQUENCE_GAP = 90;
const CELL = 0.5;
const REACH = 12;
const COARSE_RADII = [2.5, 1.5, 1, 0.6, 0.4];
const TOLERANCE_PASSES = 4;
/** Half a heading-byte step: how far a single-sample ray can point off its true direction. */
const HEADING_SLOPE = Math.tan((Math.PI * 2) / 256 / 2);
/** Species that walk fixed routes of their own rather than the zone's nodes. */
export const OWN_ROUTES = new Set(["Pixie", "Goblin_Digger"]);
const MIN_MOB_POINTS = 200;
const MIN_MOB_RAYS = 20;
const MIN_VOTES = 5;
/** Median miss of a node's rays, as a share of each ray's own tolerance. */
const MAX_NORMALISED_RESID = 0.5;
const SAME_NODE = 1;
/** Peak window for center guesses; small enough for dungeons whose nodes sit about 3 yalms apart. */
const PEAK_WINDOW = 2;
const MIN_STOP_PILE = 5;
/** Rays are only followed REACH yalms, so a radius near that is chance crossings rather than a node. */
const MAX_RADIUS = 10;
const MERGE = 1.8;
const ALIGN_RADII = [3, 1.2, 0.6];
const MIN_PAIR_MATCHES = 3;
/** Pulls a mob with nothing to align against towards no offset at all. */
const OFFSET_PRIOR = 0.01;
const MATCH_PERP = 0.25;

/** The heading byte turns clockwise from +x in steps of 360/256 degrees, centred on the step. */
export function headingVector(dir: number): [number, number] {
  const a = -((dir + 0.5) * 2 * Math.PI) / 256;
  return [Math.cos(a), Math.sin(a)];
}

/** Runs of samples that share one heading with no long gap between them. */
export function legs(points: PathPoint[]): PathPoint[][] {
  const out: PathPoint[][] = [];
  if (points.length === 0) return out;
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (b.dir === a.dir && b.t - a.t <= MAX_LEG_GAP) {
      current.push(b);
      continue;
    }
    out.push(current);
    current = [b];
  }
  out.push(current);
  return out;
}

/** Principal direction of a leg's samples on the ground plane. */
function fitDirection(leg: PathPoint[]): [number, number] {
  let mx = 0;
  let mz = 0;
  for (const p of leg) {
    mx += p.x;
    mz += p.z;
  }
  mx /= leg.length;
  mz /= leg.length;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const p of leg) {
    const dx = p.x - mx;
    const dz = p.z - mz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  return [Math.cos(angle), Math.sin(angle)];
}

/** One ray per leg that ends in a turn: from the leg's last sample, along the way it was walking. */
export function arrivalRays(points: PathPoint[]): Ray[] {
  const all = legs(points);
  const rays: Ray[] = [];
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i];
    const b = all[i + 1];
    const end = a[a.length - 1];
    const next = b[0];
    if (next.t - end.t > MAX_LEG_GAP) continue;

    const vx = end.x - a[0].x;
    const vz = end.z - a[0].z;
    const toNextX = next.x - end.x;
    const toNextZ = next.z - end.z;
    const toNext = Math.hypot(toNextX, toNextZ);

    if (a.length >= 2 && Math.hypot(vx, vz) >= 1) {
      let [dx, dz] = fitDirection(a);
      if (dx * vx + dz * vz < 0) {
        dx = -dx;
        dz = -dz;
      }
      rays.push({ x: end.x, z: end.z, dx, dz, t: end.t, fromHeading: false });
      continue;
    }
    if (toNext < 1) continue;

    const [dx, dz] = headingVector(end.dir);
    if (dx * toNextX + dz * toNextZ < -0.5 * toNext) continue;
    rays.push({ x: end.x, z: end.z, dx, dz, t: end.t, fromHeading: true });
  }
  return rays;
}

/** Separable blur and sliding maximum over a row-major grid. */
function gaussianBlur(grid: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 4);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += grid[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function maxFilter(grid: Float32Array, w: number, h: number, size: number): Float32Array {
  const half = Math.floor(size / 2);
  const tmp = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      const lo = Math.max(0, x - half);
      const hi = Math.min(w - 1, x - half + size - 1);
      for (let xx = lo; xx <= hi; xx++) m = Math.max(m, grid[y * w + xx]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      const lo = Math.max(0, y - half);
      const hi = Math.min(h - 1, y - half + size - 1);
      for (let yy = lo; yy <= hi; yy++) m = Math.max(m, tmp[yy * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Grid cells where many rays pass through: the starting guesses for node centers. */
function candidates(rays: Ray[]): [number, number][] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const r of rays) {
    minX = Math.min(minX, r.x);
    minZ = Math.min(minZ, r.z);
    maxX = Math.max(maxX, r.x);
    maxZ = Math.max(maxZ, r.z);
  }
  minX -= REACH;
  minZ -= REACH;
  maxX += REACH;
  maxZ += REACH;
  const w = Math.ceil((maxX - minX) / CELL) + 1;
  const h = Math.ceil((maxZ - minZ) / CELL) + 1;
  const grid = new Float32Array(w * h);
  const touched = new Int32Array(w * h).fill(-1);

  for (let i = 0; i < rays.length; i++) {
    const r = rays[i];
    for (let s = 0; s < REACH; s += CELL / 2) {
      const gx = Math.floor((r.x + s * r.dx - minX) / CELL);
      const gz = Math.floor((r.z + s * r.dz - minZ) / CELL);
      if (gx < 0 || gz < 0 || gx >= w || gz >= h) continue;
      const cell = gz * w + gx;
      if (touched[cell] === i) continue;
      touched[cell] = i;
      grid[cell] += 1;
    }
  }

  const blurred = gaussianBlur(grid, w, h, 1.5);
  const peaks = maxFilter(blurred, w, h, Math.round(PEAK_WINDOW / CELL));
  const out: [number, number][] = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = blurred[gz * w + gx];
      if (v > 0.5 && v === peaks[gz * w + gx]) {
        out.push([minX + (gx + 0.5) * CELL, minZ + (gz + 0.5) * CELL]);
      }
    }
  }
  return out;
}

/** Buckets ray start points so a candidate only looks at rays that could reach it. */
class RayIndex {
  private readonly cell = REACH + 3;
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly rays: Ray[]) {
    rays.forEach((r, i) => {
      const key = this.key(Math.floor(r.x / this.cell), Math.floor(r.z / this.cell));
      const bucket = this.buckets.get(key);
      if (bucket) {
        bucket.push(i);
        return;
      }
      this.buckets.set(key, [i]);
    });
  }

  private key(cx: number, cz: number) {
    return `${cx},${cz}`;
  }

  near(x: number, z: number): number[] {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const out: number[] = [];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = this.buckets.get(this.key(cx + i, cz + j));
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

/** Distance along and across a ray from its start to a point. */
function project(r: Ray, x: number, z: number): [number, number] {
  const wx = x - r.x;
  const wz = z - r.z;
  const along = wx * r.dx + wz * r.dz;
  const across = Math.abs(wx * r.dz - wz * r.dx);
  return [along, across];
}

/** How far a ray may miss a true center: a fitted leg is exact, the heading byte is off by up to half a step. */
function tolerance(r: Ray, along: number): number {
  if (r.fromHeading) return 0.03 + HEADING_SLOPE * Math.abs(along);
  return 0.05;
}

/** Weighted point closest to a set of ray lines. */
function closestPoint(rays: Ray[], used: number[], weights: number[]): [number, number] | undefined {
  let w = 0;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let bx = 0;
  let bz = 0;
  used.forEach((i, k) => {
    const r = rays[i];
    const wk = weights[k];
    w += wk;
    sxx += wk * r.dx * r.dx;
    sxz += wk * r.dx * r.dz;
    szz += wk * r.dz * r.dz;
    const de = r.dx * r.x + r.dz * r.z;
    bx += wk * (r.x - de * r.dx);
    bz += wk * (r.z - de * r.dz);
  });
  const a = w - sxx;
  const b = -sxz;
  const d = w - szz;
  const det = a * d - b * b;
  if (Math.abs(det) < 1e-4 * w * w) return undefined;
  return [(d * bx - b * bz) / det, (a * bz - b * bx) / det];
}

/** The point closest to every nearby ray line: coarse gather radii first, then each ray's own tolerance. */
function refine(x: number, z: number, rays: Ray[], nearby: number[]): { x: number; z: number; used: number[] } | undefined {
  let center: [number, number] = [x, z];
  const within = (limit: (r: Ray, along: number) => number) =>
    nearby.filter(i => {
      const [along, across] = project(rays[i], center[0], center[1]);
      return along >= -1 && along <= REACH && across <= limit(rays[i], along);
    });

  for (const radius of COARSE_RADII) {
    const used = within(() => radius);
    if (used.length < 3) return undefined;
    const next = closestPoint(rays, used, used.map(() => 1));
    if (!next) return undefined;
    center = next;
  }
  for (let pass = 0; pass < TOLERANCE_PASSES; pass++) {
    const used = within(tolerance);
    if (used.length < 3) return undefined;
    const weights = used.map(i => {
      const t = tolerance(rays[i], project(rays[i], center[0], center[1])[0]);
      return 1 / (t * t);
    });
    const next = closestPoint(rays, used, weights);
    if (!next) return undefined;
    center = next;
  }
  return { x: center[0], z: center[1], used: within(tolerance) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[m];
  return (s[m - 1] + s[m]) / 2;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * (p / 100);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Upper edge of the densest pile of leg-end distances; samples that were not the stop scatter further out. */
function stopRadius(distances: number[]): { r: number; pile: number } {
  const kept = distances.filter(d => d > -1 && d < REACH);
  const bins = Math.ceil((REACH + 1) / 0.25);
  const hist = new Array(bins).fill(0);
  for (const d of kept) hist[Math.min(bins - 1, Math.floor((d + 1) / 0.25))]++;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < bins; i++) {
    const score = (hist[i - 1] ?? 0) + hist[i] + (hist[i + 1] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const mode = -1 + (best + 0.5) * 0.25;
  const pile = kept.filter(d => d > mode - 0.9 && d < mode + 0.4);
  return { r: percentile(pile, 95), pile: pile.length };
}

export function mobNodes(rays: Ray[]): MobNode[] {
  if (rays.length === 0) return [];
  const index = new RayIndex(rays);
  const found: MobNode[] = [];
  for (const [x, z] of candidates(rays)) {
    const refined = refine(x, z, rays, index.near(x, z));
    if (!refined || refined.used.length < MIN_VOTES) continue;
    const along: number[] = [];
    const across: number[] = [];
    const normalised: number[] = [];
    for (const i of refined.used) {
      const [s, p] = project(rays[i], refined.x, refined.z);
      along.push(s);
      across.push(p);
      normalised.push(p / tolerance(rays[i], s));
    }
    if (median(normalised) >= MAX_NORMALISED_RESID) continue;
    const r = (() => {
      const stop = stopRadius(along);
      if (stop.pile >= MIN_STOP_PILE) return stop.r;
      // Sparse updates rarely catch the mob at its stop, so the closest approaches bound the radius instead.
      return Math.max(0, percentile(along, 10));
    })();
    if (r >= MAX_RADIUS) continue;
    found.push({ x: refined.x, z: refined.z, votes: refined.used.length, resid: median(across), r });
  }
  found.sort((a, b) => b.votes - a.votes);
  const kept: MobNode[] = [];
  for (const n of found) {
    if (kept.every(k => Math.hypot(n.x - k.x, n.z - k.z) > SAME_NODE)) kept.push(n);
  }
  return kept;
}

/** Single-linkage clusters of points closer than MERGE, via a hash grid and union-find. */
function cluster(xs: Float64Array, zs: Float64Array): Int32Array {
  const n = xs.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(xs[i] / MERGE)},${Math.floor(zs[i] / MERGE)}`;
    const bucket = cells.get(key);
    if (bucket) {
      bucket.push(i);
      continue;
    }
    cells.set(key, [i]);
  }
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] / MERGE);
    const cz = Math.floor(zs[i] / MERGE);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const j of cells.get(`${cx + a},${cz + b}`) ?? []) {
          if (j <= i || Math.hypot(xs[i] - xs[j], zs[i] - zs[j]) >= MERGE) continue;
          parent[find(i)] = find(j);
        }
      }
    }
  }
  const labels = new Int32Array(n);
  const ids = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    labels[i] = id;
  }
  return labels;
}

interface Consensus {
  labels: Int32Array;
  cx: Float64Array;
  cz: Float64Array;
  offsets: Map<string, [number, number]>;
}

/** Index of the node in `to` nearest a point, and how far it is. */
function nearestNode(to: MobNode[], x: number, z: number): { index: number; distance: number } {
  let index = -1;
  let distance = Infinity;
  to.forEach((t, i) => {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d >= distance) return;
    index = i;
    distance = d;
  });
  return { index, distance };
}

/** Mutual nearest node pairs between two mobs once b is moved back by `shift`; returns b - a for each pair. */
function matchPair(a: MobNode[], b: MobNode[], shift: [number, number], radius: number): [number, number][] {
  const out: [number, number][] = [];
  b.forEach((nb, j) => {
    const there = nearestNode(a, nb.x - shift[0], nb.z - shift[1]);
    if (there.index < 0 || there.distance >= radius) return;
    const na = a[there.index];
    if (nearestNode(b, na.x + shift[0], na.z + shift[1]).index !== j) return;
    out.push([nb.x - na.x, nb.z - na.z]);
  });
  return out;
}

interface PairOffset {
  a: number;
  b: number;
  dx: number;
  dz: number;
  weight: number;
}

/**
 * Per-mob offsets from pairwise differences off[b] - off[a] = d, by least squares with a weak pull to zero.
 * The normal equations are a weighted graph Laplacian plus a small diagonal, solved by conjugate gradient.
 */
function solveOffsets(count: number, pairs: PairOffset[]): [number, number][] {
  const neighbours: { other: number; weight: number }[][] = Array.from({ length: count }, () => []);
  const degree = new Float64Array(count).fill(OFFSET_PRIOR);
  const rhsX = new Float64Array(count);
  const rhsZ = new Float64Array(count);
  for (const p of pairs) {
    neighbours[p.a].push({ other: p.b, weight: p.weight });
    neighbours[p.b].push({ other: p.a, weight: p.weight });
    degree[p.a] += p.weight;
    degree[p.b] += p.weight;
    rhsX[p.b] += p.weight * p.dx;
    rhsX[p.a] -= p.weight * p.dx;
    rhsZ[p.b] += p.weight * p.dz;
    rhsZ[p.a] -= p.weight * p.dz;
  }
  const apply = (v: Float64Array) => {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let acc = degree[i] * v[i];
      for (const { other, weight } of neighbours[i]) acc -= weight * v[other];
      out[i] = acc;
    }
    return out;
  };
  const dot = (u: Float64Array, v: Float64Array) => u.reduce((acc, x, i) => acc + x * v[i], 0);
  const solve = (rhs: Float64Array) => {
    const x = new Float64Array(count);
    const r = Float64Array.from(rhs);
    const p = Float64Array.from(rhs);
    let rr = dot(r, r);
    for (let it = 0; it < count * 2 && rr > 1e-12; it++) {
      const ap = apply(p);
      const alpha = rr / dot(p, ap);
      for (let i = 0; i < count; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * ap[i];
      }
      const next = dot(r, r);
      for (let i = 0; i < count; i++) p[i] = r[i] + (next / rr) * p[i];
      rr = next;
    }
    return x;
  };
  const ox = solve(rhsX);
  const oz = solve(rhsZ);
  return Array.from(ox, (x, i) => [x, oz[i]] as [number, number]);
}

/** Removes each mob's own aim offset by aligning every overlapping pair of mobs, then clusters their nodes into shared ones. */
function consensus(perMob: Map<string, MobNode[]>): Consensus {
  const mobs = [...perMob.keys()];
  const nodes = mobs.map(m => perMob.get(m));
  const boxes = nodes.map(ns => {
    const xs = ns.map(n => n.x);
    const zs = ns.map(n => n.z);
    return [Math.min(...xs) - 3, Math.min(...zs) - 3, Math.max(...xs) + 3, Math.max(...zs) + 3];
  });
  const overlapping: [number, number][] = [];
  for (let a = 0; a < mobs.length; a++) {
    for (let b = a + 1; b < mobs.length; b++) {
      const [ax0, az0, ax1, az1] = boxes[a];
      const [bx0, bz0, bx1, bz1] = boxes[b];
      if (ax0 < bx1 && bx0 < ax1 && az0 < bz1 && bz0 < az1) overlapping.push([a, b]);
    }
  }

  let offsets: [number, number][] = mobs.map(() => [0, 0]);
  for (const radius of ALIGN_RADII) {
    const pairs: PairOffset[] = [];
    for (const [a, b] of overlapping) {
      const shift: [number, number] = [offsets[b][0] - offsets[a][0], offsets[b][1] - offsets[a][1]];
      const diffs = matchPair(nodes[a], nodes[b], shift, radius);
      if (diffs.length < MIN_PAIR_MATCHES) continue;
      pairs.push({ a, b, dx: median(diffs.map(d => d[0])), dz: median(diffs.map(d => d[1])), weight: diffs.length });
    }
    offsets = solveOffsets(mobs.length, pairs);
  }

  const owners = nodes.flatMap((ns, i) => ns.map(() => i));
  const flat = nodes.flat();
  const xs = Float64Array.from(flat, (n, i) => n.x - offsets[owners[i]][0]);
  const zs = Float64Array.from(flat, (n, i) => n.z - offsets[owners[i]][1]);
  const labels = cluster(xs, zs);
  const k = labels.reduce((m, l) => Math.max(m, l + 1), 0);
  const cx = new Float64Array(k);
  const cz = new Float64Array(k);
  const count = new Int32Array(k);
  for (let i = 0; i < flat.length; i++) {
    cx[labels[i]] += xs[i];
    cz[labels[i]] += zs[i];
    count[labels[i]]++;
  }
  for (let i = 0; i < k; i++) {
    cx[i] /= count[i];
    cz[i] /= count[i];
  }
  return { labels, cx, cz, offsets: new Map(mobs.map((m, i) => [m, offsets[i]])) };
}

/** For each ray, which of the mob's own nodes it was walking to, if any. */
export function matchRays(rays: Ray[], nodes: MobNode[]): number[] {
  return rays.map(r => {
    let best = -1;
    let bestAlong = Infinity;
    nodes.forEach((n, i) => {
      const [along, across] = project(r, n.x, n.z);
      if (across >= MATCH_PERP || along <= 0 || along >= REACH || along >= bestAlong) return;
      best = i;
      bestAlong = along;
    });
    return best;
  });
}

/** Node height from the recorded samples nearest its center. */
function heights(data: PathData, xs: Float64Array, zs: Float64Array): Float64Array {
  const size = 4;
  const cells = new Map<string, number[]>();
  const all: number[] = [];
  for (const mob of Object.values(data)) {
    for (const p of mob.points) {
      const i = all.length / 3;
      all.push(p.x, p.y, p.z);
      const key = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
      const bucket = cells.get(key);
      if (bucket) {
        bucket.push(i);
        continue;
      }
      cells.set(key, [i]);
    }
  }
  const out = new Float64Array(xs.length);
  for (let k = 0; k < xs.length; k++) {
    const cx = Math.floor(xs[k] / size);
    const cz = Math.floor(zs[k] / size);
    const near: [number, number][] = [];
    for (let ring = 1; ring <= 4 && near.length < 5; ring++) {
      near.length = 0;
      for (let a = -ring; a <= ring; a++) {
        for (let b = -ring; b <= ring; b++) {
          for (const i of cells.get(`${cx + a},${cz + b}`) ?? []) {
            near.push([Math.hypot(all[i * 3] - xs[k], all[i * 3 + 2] - zs[k]), all[i * 3 + 1]]);
          }
        }
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    out[k] = median(near.slice(0, 5).map(n => n[1]));
  }
  return out;
}

export type Progress = (stage: string, done: number, total: number) => void;

export function extract(data: PathData, progress: Progress = () => {}): Extraction {
  const ids = Object.keys(data);
  const perMob = new Map<string, { name: string; rays: Ray[]; nodes: MobNode[] }>();
  ids.forEach((id, i) => {
    progress("Finding each mob's nodes", i, ids.length);
    const mob = data[id];
    if (mob.points.length < MIN_MOB_POINTS || OWN_ROUTES.has(mob.name.replaceAll(" ", "_"))) return;
    const rays = arrivalRays(mob.points);
    if (rays.length < MIN_MOB_RAYS) return;
    const nodes = mobNodes(rays);
    if (nodes.length > 0) perMob.set(id, { name: mob.name.replaceAll("_", " "), rays, nodes });
  });

  progress("Lining mobs up", 0, 1);
  const { labels, cx, cz, offsets } = consensus(new Map([...perMob].map(([mob, m]) => [mob, m.nodes])));

  progress("Linking nodes", 0, 1);
  const mobs: Record<string, MobResult> = {};
  const edgeCounts = new Map<string, number>();
  let arrivals = 0;
  let row = 0;
  for (const [id, m] of perMob) {
    const nodeIds = m.nodes.map(() => labels[row++]);
    mobs[id] = { name: m.name, nodes: m.nodes, nodeIds, offset: offsets.get(id) };
    const matched = matchRays(m.rays, m.nodes);
    let previous = -1;
    let lastT = -Infinity;
    m.rays.forEach((r, i) => {
      if (r.t - lastT > SEQUENCE_GAP) previous = -1;
      lastT = r.t;
      if (matched[i] < 0) {
        previous = -1;
        return;
      }
      const current = nodeIds[matched[i]];
      arrivals++;
      if (previous >= 0 && previous !== current) {
        const key = `${Math.min(previous, current)},${Math.max(previous, current)}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
      previous = current;
    });
  }

  progress("Measuring heights", 0, 1);
  const ys = heights(data, cx, cz);
  const radii: number[][] = Array.from({ length: cx.length }, () => []);
  const mobSets: Set<string>[] = Array.from({ length: cx.length }, () => new Set());
  const species: Set<string>[] = Array.from({ length: cx.length }, () => new Set());
  for (const [id, m] of Object.entries(mobs)) {
    m.nodes.forEach((n, i) => {
      radii[m.nodeIds[i]].push(n.r);
      mobSets[m.nodeIds[i]].add(id);
      species[m.nodeIds[i]].add(m.name);
    });
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  const nodes: Node[] = Array.from(cx, (_, i) => ({
    id: i,
    x: round(cx[i]),
    y: round(ys[i]),
    z: round(cz[i]),
    r: round(median(radii[i])),
    mobs: mobSets[i].size,
    species: [...species[i]].sort(),
  }));
  const edges: Edge[] = [...edgeCounts].map(([key, count]) => {
    const [a, b] = key.split(",").map(Number);
    return { a, b, count };
  });
  return { nodes, edges, mobs, arrivals };
}
