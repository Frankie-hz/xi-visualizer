// Fills the places no node could be extracted, the way retail's own nodes look.
//
// Retail nodes are spread like blue noise: never closer than a minimum gap, and that gap is set per
// area (about 3.4 yalms in Dragon's Aery, 9 in East Ronfaure). A node's radius is about a quarter of
// the distance to its nearest neighbour. So a gap is filled by scattering points over walkable
// ground, each at least the local gap from every other node, using the gap measured from the
// extracted nodes around it. Walkable ground is where mobs were seen, plus the parts of the server's
// navmesh those mobs can reach, so ground nobody recorded is filled too.

import type { ParsedNavMesh } from "../graphics/navmesh";
import { OWN_ROUTES, type Edge, type Node, type PathData } from "./extract";

const CELL = 1;
const CLOSING_STEPS = 2;
/** Enclosed patches up to this many cells are gaps between samples; larger ones are rocks, ponds or walls. */
const MAX_HOLE_CELLS = 40;
/** Walkable patches smaller than this come from stray samples, such as a mob pulled off its route. */
const MIN_PATCH_CELLS = 25;
const SPACING_GRID = 10;
/** The local gap is the median over the extracted nodes within this window, when it holds enough of them. */
const SPACING_WINDOW = 60;
const MIN_SPACING_SAMPLES = 5;
const FALLBACK_SPACING = 8;
/** A navmesh island is kept when this many roam samples fall on it: mobs can reach it. */
const MIN_ISLAND_SAMPLES = 20;
/** With no roam data at all, islands holding at least this share of the navmesh are kept. */
const MIN_ISLAND_SHARE = 0.01;
/**
 * Ground counts as reachable when it can be walked to from ground mobs were recorded on without
 * rising or dropping more than this many yalms per yalm. LSB's navmesh also covers cliff tops and
 * terrain outside the zone walls; the rock faces between are steeper than this, the dunes and
 * valleys players walk are not.
 */
const MAX_SLOPE = 0.6;
/** A recorded sample starts the walk from the navmesh floor within this many yalms of its height. */
const SEED_HEIGHT_MATCH = 3;
/** Floor at or below a deep-water surface, give or take this many yalms, is sea: LSB's navmesh covers it too. */
const WATER_MARGIN = 0.5;
/** Cells whose centre is this close outside a triangle still count as covered, so tile seams do not split the ground. */
const RASTER_TOLERANCE = 0.05;
/** Link check: step length along the line; each step may rise or drop what the slope allows, plus a little for mesh noise. */
const LINK_STEP = 0.25;
const LINK_MAX_RISE = MAX_SLOPE * LINK_STEP + 0.2;
/** Two navmesh surfaces over one cell further apart than this are separate floors. */
const FLOOR_GAP = 2;
/**
 * Only for a zone with no extracted nodes at all: gap from openness (the widest clearance within
 * OPENNESS_REACH), fitted on Valkurm Dunes where the two track each other. Dungeons do not follow it.
 */
const OPENNESS_REACH = 10;
const OPENNESS_RATIO = 0.4;
const MIN_OPEN_SPACING = 4;
const MAX_OPEN_SPACING = 12;
const RADIUS_RATIO = 0.25;
const MIN_RADIUS = 0.5;
const MAX_RADIUS = 7;
/** Links reach this many times the local gap; retail's links mostly run 1.2 to 2 times it. */
const LINK_FACTOR = 1.8;
const HEIGHT_SAMPLES = 5;
const SEED = 7;

export interface Generated {
  nodes: Node[];
  edges: Edge[];
}

/** The up to four grid neighbours of a cell in a row-major grid. */
function neighbours(i: number, w: number, h: number): number[] {
  const x = i % w;
  const z = Math.floor(i / w);
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < w - 1) out.push(i + 1);
  if (z > 0) out.push(i - w);
  if (z < h - 1) out.push(i + w);
  return out;
}

/** The value nearest a reference; `values` must not be empty. */
function closestTo(values: number[], reference: number): number {
  let best = values[0];
  for (const v of values) {
    if (Math.abs(v - reference) < Math.abs(best - reference)) best = v;
  }
  return best;
}

/** Small seeded generator so the same roam data always gives the same fill. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[m];
  return (s[m - 1] + s[m]) / 2;
}

/** Hash grid over 2D points for radius queries. */
class PointIndex {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly size: number) {}

  private key(x: number, z: number) {
    return `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
  }

  add(id: number, x: number, z: number) {
    const key = this.key(x, z);
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.push(id);
      return;
    }
    this.buckets.set(key, [id]);
  }

  /** Ids in the cells around a point; the caller checks the exact distance. */
  near(x: number, z: number, reach: number): number[] {
    const steps = Math.ceil(reach / this.size);
    const cx = Math.floor(x / this.size);
    const cz = Math.floor(z / this.size);
    const out: number[] = [];
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        const bucket = this.buckets.get(`${cx + i},${cz + j}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

/** Where mobs were seen, on a one-yalm grid: closed so the stretch between two samples counts, holes filled, edge grown by a cell. */
class Walkable {
  readonly width: number;
  readonly height: number;
  readonly cells: Uint8Array;

  constructor(readonly minX: number, readonly minZ: number, maxX: number, maxZ: number) {
    this.width = Math.ceil((maxX - minX) / CELL) + 1;
    this.height = Math.ceil((maxZ - minZ) / CELL) + 1;
    this.cells = new Uint8Array(this.width * this.height);
  }

  index(x: number, z: number): number {
    const gx = Math.floor((x - this.minX) / CELL);
    const gz = Math.floor((z - this.minZ) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.width || gz >= this.height) return -1;
    return gz * this.width + gx;
  }

  at(x: number, z: number): boolean {
    const i = this.index(x, z);
    return i >= 0 && this.cells[i] === 1;
  }

  /** Every point along the segment, half a cell apart, is walkable. */
  clearLine(ax: number, az: number, bx: number, bz: number): boolean {
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 2)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.at(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  private step(grow: boolean) {
    const out = new Uint8Array(this.cells.length);
    for (let i = 0; i < this.cells.length; i++) {
      const around = neighbours(i, this.width, this.height);
      const values = [this.cells[i], ...around.map(j => this.cells[j])];
      if (grow) {
        out[i] = Number(values.some(v => v === 1));
        continue;
      }
      // A cell on the grid border has an empty neighbour off the edge, so it erodes.
      out[i] = Number(around.length === 4 && values.every(v => v === 1));
    }
    this.cells.set(out);
  }

  /** Marks small enclosed patches walkable: each unwalkable patch is flooded, and kept only if it is large or reaches the border. */
  private fillSmallHoles() {
    const w = this.width;
    const h = this.height;
    const seen = new Uint8Array(this.cells.length);
    for (let start = 0; start < this.cells.length; start++) {
      if (this.cells[start] === 1 || seen[start] === 1) continue;
      const patch = [start];
      seen[start] = 1;
      let open = false;
      for (let head = 0; head < patch.length; head++) {
        const i = patch[head];
        const x = i % w;
        const z = Math.floor(i / w);
        if (x === 0 || z === 0 || x === w - 1 || z === h - 1) open = true;
        for (const j of neighbours(i, w, h)) {
          if (this.cells[j] === 1 || seen[j] === 1) continue;
          seen[j] = 1;
          patch.push(j);
        }
      }
      if (open || patch.length > MAX_HOLE_CELLS) continue;
      for (const i of patch) this.cells[i] = 1;
    }
  }

  /** Clears walkable patches too small to hold a route. */
  private dropSmallPatches() {
    const w = this.width;
    const h = this.height;
    const seen = new Uint8Array(this.cells.length);
    for (let start = 0; start < this.cells.length; start++) {
      if (this.cells[start] === 0 || seen[start] === 1) continue;
      const patch = [start];
      seen[start] = 1;
      for (let head = 0; head < patch.length; head++) {
        for (const j of neighbours(patch[head], w, h)) {
          if (this.cells[j] === 0 || seen[j] === 1) continue;
          seen[j] = 1;
          patch.push(j);
        }
      }
      if (patch.length >= MIN_PATCH_CELLS) continue;
      for (const i of patch) this.cells[i] = 0;
    }
  }

  shape() {
    for (let s = 0; s < CLOSING_STEPS; s++) this.step(true);
    for (let s = 0; s < CLOSING_STEPS; s++) this.step(false);
    this.fillSmallHoles();
    this.dropSmallPatches();
  }
}

/** Exact point-on-navmesh lookups: triangles bucketed on a coarse grid, tested in the ground plane. */
class NavIndex {
  private readonly size = 4;
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly positions: number[], private readonly keep: (triangle: number) => boolean) {
    for (let t = 0; t < positions.length / 9; t++) {
      if (!keep(t)) continue;
      const o = t * 9;
      const xs = [positions[o], positions[o + 3], positions[o + 6]];
      const zs = [positions[o + 2], positions[o + 5], positions[o + 8]];
      for (let gx = Math.floor(Math.min(...xs) / this.size); gx <= Math.floor(Math.max(...xs) / this.size); gx++) {
        for (let gz = Math.floor(Math.min(...zs) / this.size); gz <= Math.floor(Math.max(...zs) / this.size); gz++) {
          const key = `${gx},${gz}`;
          const bucket = this.buckets.get(key);
          if (bucket) {
            bucket.push(t);
            continue;
          }
          this.buckets.set(key, [t]);
        }
      }
    }
  }

  /** Heights of every kept navmesh surface directly above or below a point. */
  floors(x: number, z: number): number[] {
    const out: number[] = [];
    for (const t of this.buckets.get(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`) ?? []) {
      const o = t * 9;
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = this.positions.slice(o, o + 9);
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push(l1 * ay + l2 * by + l3 * cy);
    }
    return out;
  }

  /** The floor at a point nearest a reference height, if there is one. */
  floorNear(x: number, z: number, reference: number): number | undefined {
    const floors = this.floors(x, z);
    if (floors.length === 0) return undefined;
    return closestTo(floors, reference);
  }

  /** The straight line stays on reachable navmesh the whole way, never steeper than MAX_SLOPE. */
  walkableLine(ax: number, ay: number, az: number, bx: number, by: number, bz: number, onGround: (x: number, z: number) => boolean): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / LINK_STEP));
    let height = ay;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (!onGround(x, z)) return false;
      const next = this.floorNear(x, z, height);
      if (next === undefined || Math.abs(next - height) > LINK_MAX_RISE) return false;
      height = next;
    }
    return Math.abs(height - by) <= LINK_MAX_RISE;
  }
}

/** Navmesh triangles painted onto the walkable grid: the island each cell belongs to and up to two floor heights. */
interface NavRaster {
  island: Int32Array;
  floorA: Float32Array;
  floorB: Float32Array;
}

function navTriangles(nav: ParsedNavMesh): { positions: number[]; islands: number[] } {
  const positions: number[] = [];
  const islands: number[] = [];
  let emitted = 0;
  for (const tile of nav.tiles) {
    let tri = 0;
    for (const count of tile.polyTriCounts) {
      const island = nav.components.idOfPoly[emitted++];
      for (let k = 0; k < count; k++) {
        for (let v = 0; v < 9; v++) positions.push(tile.positions[(tri + k) * 9 + v]);
        islands.push(island);
      }
      tri += count;
    }
  }
  return { positions, islands };
}

function rasterizeNav(walkable: Walkable, positions: number[], islands: number[]): NavRaster {
  const size = walkable.cells.length;
  const raster = {
    island: new Int32Array(size).fill(-1),
    floorA: new Float32Array(size).fill(NaN),
    floorB: new Float32Array(size).fill(NaN),
  };
  for (let t = 0; t < islands.length; t++) {
    const o = t * 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(o, o + 9);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.floor((Math.min(ax, bx, cx) - walkable.minX) / CELL);
    const x1 = Math.floor((Math.max(ax, bx, cx) - walkable.minX) / CELL);
    const z0 = Math.floor((Math.min(az, bz, cz) - walkable.minZ) / CELL);
    const z1 = Math.floor((Math.max(az, bz, cz) - walkable.minZ) / CELL);
    for (let gz = Math.max(0, z0); gz <= Math.min(walkable.height - 1, z1); gz++) {
      for (let gx = Math.max(0, x0); gx <= Math.min(walkable.width - 1, x1); gx++) {
        const px = walkable.minX + (gx + 0.5) * CELL;
        const pz = walkable.minZ + (gz + 0.5) * CELL;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -RASTER_TOLERANCE || l2 < -RASTER_TOLERANCE || l3 < -RASTER_TOLERANCE) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        const i = gz * walkable.width + gx;
        raster.island[i] = islands[t];
        if (Number.isNaN(raster.floorA[i])) {
          raster.floorA[i] = y;
          continue;
        }
        if (Math.abs(y - raster.floorA[i]) > FLOOR_GAP && Number.isNaN(raster.floorB[i])) raster.floorB[i] = y;
      }
    }
  }
  return raster;
}

/** Islands mobs were seen on; with no roam data, every island big enough to matter. */
function reachableIslands(walkable: Walkable, raster: NavRaster, samples: Float64Array): Set<number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < samples.length; i += 3) {
    const cell = walkable.index(samples[i], samples[i + 2]);
    if (cell < 0 || raster.island[cell] < 0) continue;
    counts.set(raster.island[cell], (counts.get(raster.island[cell]) ?? 0) + 1);
  }
  if (samples.length > 0) return new Set([...counts].filter(([, n]) => n >= MIN_ISLAND_SAMPLES).map(([id]) => id));
  const cells = new Map<number, number>();
  let total = 0;
  for (const id of raster.island) {
    if (id < 0) continue;
    cells.set(id, (cells.get(id) ?? 0) + 1);
    total++;
  }
  return new Set([...cells].filter(([, n]) => n >= MIN_ISLAND_SHARE * total).map(([id]) => id));
}

interface Ground {
  walkable: Walkable;
  samples: Float64Array;
  raster?: NavRaster;
  /** Present when there is a navmesh: then it, not the samples, decides what is walkable. */
  navIndex?: NavIndex;
  /** Navmesh floor height each reachable cell was reached at, NaN elsewhere. */
  reached?: Float32Array;
  /** Cells where mobs were recorded (samples closed over small gaps); 1 or 0 per cell. */
  recorded: Uint8Array;
}

/** Highest deep-water surface over each cell (the smallest y, since FFXI y grows downward), NaN where there is none. */
function rasterizeWater(walkable: Walkable, water: Float32Array): Float32Array {
  const top = new Float32Array(walkable.cells.length).fill(NaN);
  for (let o = 0; o + 9 <= water.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = water.subarray(o, o + 9);
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - walkable.minX) / CELL));
    const x1 = Math.min(walkable.width - 1, Math.floor((Math.max(ax, bx, cx) - walkable.minX) / CELL));
    const z0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - walkable.minZ) / CELL));
    const z1 = Math.min(walkable.height - 1, Math.floor((Math.max(az, bz, cz) - walkable.minZ) / CELL));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const px = walkable.minX + (gx + 0.5) * CELL;
        const pz = walkable.minZ + (gz + 0.5) * CELL;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const y = l1 * ay + l2 * by + l3 * cy;
        const i = gz * walkable.width + gx;
        if (Number.isNaN(top[i]) || y < top[i]) top[i] = y;
      }
    }
  }
  return top;
}

/**
 * Walks the navmesh out from every recorded sample, one cell at a time, onto neighbouring floor that
 * is no steeper than MAX_SLOPE and not under deep water. Returns the floor height each cell was
 * reached at. With no samples at all, every dry cell of the kept islands counts.
 */
function spreadFromRecorded(walkable: Walkable, raster: NavRaster, waterTop: Float32Array, samples: Float64Array, islands: Set<number>): Float32Array {
  const reached = new Float32Array(walkable.cells.length).fill(NaN);
  const dryFloors = (i: number) =>
    [raster.floorA[i], raster.floorB[i]].filter(y => !Number.isNaN(y) && (Number.isNaN(waterTop[i]) || y < waterTop[i] - WATER_MARGIN));

  if (samples.length === 0) {
    raster.island.forEach((id, i) => {
      const floors = dryFloors(i);
      if (islands.has(id) && floors.length > 0) reached[i] = floors[0];
    });
    return reached;
  }

  const queue: number[] = [];
  for (let s = 0; s < samples.length; s += 3) {
    const i = walkable.index(samples[s], samples[s + 2]);
    if (i < 0 || !Number.isNaN(reached[i])) continue;
    const floors = dryFloors(i);
    if (floors.length === 0) continue;
    const floor = closestTo(floors, samples[s + 1]);
    if (Math.abs(floor - samples[s + 1]) > SEED_HEIGHT_MATCH) continue;
    reached[i] = floor;
    queue.push(i);
  }
  const w = walkable.width;
  const h = walkable.height;
  // Each cell is queued at most once, so the queue is bounded by the grid.
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbours(i, w, h)) {
      if (!Number.isNaN(reached[j])) continue;
      const floors = dryFloors(j).filter(y => Math.abs(y - reached[i]) <= MAX_SLOPE * CELL);
      if (floors.length === 0) continue;
      reached[j] = closestTo(floors, reached[i]);
      queue.push(j);
    }
  }
  return reached;
}

function groundFrom(data: PathData, nav: ParsedNavMesh | undefined, water: Float32Array | undefined): Ground {
  const flat: number[] = [];
  for (const mob of Object.values(data)) {
    if (OWN_ROUTES.has(mob.name.replaceAll(" ", "_"))) continue;
    for (const p of mob.points) flat.push(p.x, p.y, p.z);
  }
  const triangles = (() => {
    if (!nav) return { positions: [], islands: [] };
    return navTriangles(nav);
  })();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const extend = (x: number, z: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (let i = 0; i < flat.length; i += 3) extend(flat[i], flat[i + 2]);
  for (let i = 0; i < triangles.positions.length; i += 3) extend(triangles.positions[i], triangles.positions[i + 2]);
  const walkable = new Walkable(minX - 5, minZ - 5, maxX + 5, maxZ + 5);
  const samples = Float64Array.from(flat);
  for (let i = 0; i < flat.length; i += 3) walkable.cells[walkable.index(flat[i], flat[i + 2])] = 1;
  walkable.shape();
  const recorded = walkable.cells.slice();
  if (!nav) return { walkable, samples, recorded };

  // With a navmesh, recorded ground only says where the walk starts; walkable cells are the navmesh cells it reaches.
  const raster = rasterizeNav(walkable, triangles.positions, triangles.islands);
  const waterTop = (() => {
    if (!water) return new Float32Array(walkable.cells.length).fill(NaN);
    return rasterizeWater(walkable, water);
  })();
  const reached = spreadFromRecorded(walkable, raster, waterTop, samples, reachableIslands(walkable, raster, samples));
  walkable.cells.fill(0);
  reached.forEach((y, i) => {
    if (!Number.isNaN(y)) walkable.cells[i] = 1;
  });
  const navIndex = new NavIndex(triangles.positions, () => true);
  return { walkable, samples, raster, navIndex, reached, recorded };
}

/** Distance in cells from each walkable cell to the nearest unwalkable one (two-pass chamfer). */
function clearance(walkable: Walkable): Float32Array {
  const w = walkable.width;
  const h = walkable.height;
  const d = new Float32Array(walkable.cells.length);
  walkable.cells.forEach((v, i) => {
    d[i] = 0;
    if (v === 1) d[i] = Infinity;
  });
  const relax = (i: number, j: number, cost: number) => {
    if (d[j] + cost < d[i]) d[i] = d[j] + cost;
  };
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (x > 0) relax(i, i - 1, 1);
      if (z > 0) relax(i, i - w, 1);
      if (x > 0 && z > 0) relax(i, i - w - 1, Math.SQRT2);
      if (x < w - 1 && z > 0) relax(i, i - w + 1, Math.SQRT2);
    }
  }
  for (let z = h - 1; z >= 0; z--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = z * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (z < h - 1) relax(i, i + w, 1);
      if (x < w - 1 && z < h - 1) relax(i, i + w + 1, Math.SQRT2);
      if (x > 0 && z < h - 1) relax(i, i + w - 1, Math.SQRT2);
    }
  }
  return d;
}

/**
 * Local minimum gap on a coarse grid: the median nearest-neighbour distance of the extracted nodes
 * around each cell, so an area's style carries into the unrecorded ground next to it. Ground with
 * too few extracted nodes nearby takes the zone's typical gap, not that of whichever small group of
 * nodes happens to be nearest.
 */
function spacingField(existing: Node[], walkable: Walkable) {
  const index = new PointIndex(SPACING_GRID);
  existing.forEach((n, i) => index.add(i, n.x, n.z));
  const nearest = existing.map((n, i) => {
    let best = Infinity;
    for (const j of index.near(n.x, n.z, 30)) {
      if (j === i) continue;
      best = Math.min(best, Math.hypot(existing[j].x - n.x, existing[j].z - n.z));
    }
    return best;
  });
  const usable = existing.map((_, i) => i).filter(i => Number.isFinite(nearest[i]));
  const typical = (() => {
    if (usable.length === 0) return FALLBACK_SPACING;
    return median(usable.map(i => nearest[i]));
  })();

  const openSpacing = (() => {
    if (usable.length > 0) return undefined;
    const clear = clearance(walkable);
    return (x: number, z: number) => {
      const reach = Math.round(OPENNESS_REACH / CELL);
      const gx = Math.floor((x - walkable.minX) / CELL);
      const gz = Math.floor((z - walkable.minZ) / CELL);
      let open = 0;
      for (let dz = -reach; dz <= reach; dz += 2) {
        for (let dx = -reach; dx <= reach; dx += 2) {
          const xx = gx + dx;
          const zz = gz + dz;
          if (xx < 0 || zz < 0 || xx >= walkable.width || zz >= walkable.height) continue;
          open = Math.max(open, clear[zz * walkable.width + xx]);
        }
      }
      return Math.min(MAX_OPEN_SPACING, Math.max(MIN_OPEN_SPACING, OPENNESS_RATIO * open * CELL));
    };
  })();

  const cache = new Map<string, number>();
  return (x: number, z: number) => {
    const key = `${Math.floor(x / SPACING_GRID)},${Math.floor(z / SPACING_GRID)}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const cx = (Math.floor(x / SPACING_GRID) + 0.5) * SPACING_GRID;
    const cz = (Math.floor(z / SPACING_GRID) + 0.5) * SPACING_GRID;
    const value = (() => {
      if (openSpacing) return openSpacing(cx, cz);
      const distanceTo = (i: number) => Math.hypot(existing[i].x - cx, existing[i].z - cz);
      const inWindow = index.near(cx, cz, SPACING_WINDOW).filter(i => Number.isFinite(nearest[i]) && distanceTo(i) < SPACING_WINDOW);
      if (inWindow.length >= MIN_SPACING_SAMPLES) return median(inWindow.map(i => nearest[i]));
      return typical;
    })();
    cache.set(key, value);
    return value;
  };
}

/**
 * Node height: the recorded samples right around it when there are any; otherwise the navmesh floor
 * nearest the samples in the wider area, which picks the right one where floors are stacked.
 */
function heightAt(ground: Ground, index: PointIndex, x: number, z: number): number {
  const nearby = (reach: number) =>
    index
      .near(x, z, reach)
      .map(i => ({ d: Math.hypot(ground.samples[i * 3] - x, ground.samples[i * 3 + 2] - z), y: ground.samples[i * 3 + 1] }))
      .filter(s => s.d <= reach)
      .sort((a, b) => a.d - b.d);
  const cell = ground.walkable.index(x, z);
  if (ground.reached && ground.navIndex && cell >= 0 && !Number.isNaN(ground.reached[cell])) {
    return ground.navIndex.floorNear(x, z, ground.reached[cell]) ?? ground.reached[cell];
  }
  const close = nearby(4);
  if (close.length >= HEIGHT_SAMPLES) {
    const recorded = median(close.slice(0, HEIGHT_SAMPLES).map(s => s.y));
    return ground.navIndex?.floorNear(x, z, recorded) ?? recorded;
  }

  const floors = (() => {
    if (ground.navIndex) return ground.navIndex.floors(x, z);
    if (!ground.raster || cell < 0) return [];
    return [ground.raster.floorA[cell], ground.raster.floorB[cell]].filter(y => !Number.isNaN(y));
  })();
  const wider = nearby(32);
  if (floors.length === 0) {
    if (wider.length > 0) return median(wider.slice(0, HEIGHT_SAMPLES).map(s => s.y));
    return 0;
  }
  if (floors.length === 1 || wider.length === 0) return floors[0];
  const reference = median(wider.slice(0, HEIGHT_SAMPLES).map(s => s.y));
  return closestTo(floors, reference);
}

/**
 * New nodes and links for the walkable ground the extracted nodes do not reach. Existing nodes are
 * kept as they are; new nodes are numbered from `firstId`, which must be past every id already in use.
 */
export function fillGaps(data: PathData, existing: Node[], firstId: number, nav?: ParsedNavMesh, water?: Float32Array): Generated {
  const ground = groundFrom(data, nav, water);
  const { walkable, samples } = ground;
  const spacing = spacingField(existing, walkable);
  const random = mulberry32(SEED);

  const cells: number[] = [];
  walkable.cells.forEach((v, i) => {
    if (v === 1) cells.push(i);
  });
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  interface Placed {
    x: number;
    z: number;
    gap: number;
  }
  const placed: Placed[] = existing.map(n => ({ x: n.x, z: n.z, gap: spacing(n.x, n.z) }));
  const largestGap = Math.max(FALLBACK_SPACING, ...placed.map(p => p.gap));
  const index = new PointIndex(largestGap);
  placed.forEach((p, i) => index.add(i, p.x, p.z));

  for (const cell of cells) {
    const x = walkable.minX + ((cell % walkable.width) + random()) * CELL;
    const z = walkable.minZ + (Math.floor(cell / walkable.width) + random()) * CELL;
    if (ground.navIndex && ground.navIndex.floors(x, z).length === 0) continue;
    const gap = spacing(x, z);
    const crowded = index.near(x, z, gap).some(i => Math.hypot(placed[i].x - x, placed[i].z - z) < Math.min(gap, placed[i].gap));
    if (crowded) continue;
    index.add(placed.length, x, z);
    placed.push({ x, z, gap });
  }

  const firstNew = existing.length;
  const nearestGap = placed.map((p, i) => {
    let best = Infinity;
    for (const j of index.near(p.x, p.z, largestGap * 2)) {
      if (j !== i) best = Math.min(best, Math.hypot(placed[j].x - p.x, placed[j].z - p.z));
    }
    return best;
  });

  const sampleIndex = new PointIndex(4);
  for (let i = 0; i < samples.length / 3; i++) sampleIndex.add(i, samples[i * 3], samples[i * 3 + 2]);

  const idOf = (i: number) => {
    if (i < firstNew) return existing[i].id;
    return firstId + (i - firstNew);
  };
  const round = (v: number) => Math.round(v * 100) / 100;
  const heightOf = (i: number) => {
    if (i < firstNew) return existing[i].y;
    return nodes[i - firstNew].y;
  };
  const nodes: Node[] = placed.slice(firstNew).map((p, k) => {
    const i = firstNew + k;
    const r = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, RADIUS_RATIO * nearestGap[i]));
    const onRecorded = ground.recorded[walkable.index(p.x, p.z)] === 1;
    const kind = (() => {
      if (onRecorded) return "recorded" as const;
      return "navmesh" as const;
    })();
    return {
      id: idOf(i),
      x: round(p.x),
      y: round(heightAt(ground, sampleIndex, p.x, p.z)),
      z: round(p.z),
      r: round(r),
      mobs: 0,
      species: [],
      generated: true,
      ground: kind,
    };
  });

  const edges: Edge[] = [];
  for (let i = firstNew; i < placed.length; i++) {
    const a = placed[i];
    for (const j of index.near(a.x, a.z, LINK_FACTOR * largestGap)) {
      if (j === i || (j >= firstNew && j < i)) continue;
      const b = placed[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > LINK_FACTOR * Math.max(a.gap, b.gap)) continue;
      const clear = (() => {
        if (ground.navIndex) return ground.navIndex.walkableLine(a.x, heightOf(i), a.z, b.x, heightOf(j), b.z, (x, z) => walkable.at(x, z));
        return walkable.clearLine(a.x, a.z, b.x, b.z);
      })();
      if (!clear) continue;
      edges.push({ a: idOf(i), b: idOf(j), count: 0, generated: true });
    }
  }
  const linked = new Set(edges.flatMap(e => [e.a, e.b]));
  return { nodes: nodes.filter(n => linked.has(n.id)), edges };
}
