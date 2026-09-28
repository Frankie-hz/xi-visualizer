import { simplifyRing } from "./regions.ts";
import type { Ring, Vertex } from "./regions.ts";

/**
 * Obstacles read off the collision mesh: a tree trunk, a rock, a fence post is a cluster of faces
 * too steep to stand on. Ringing one with a hole at a margin is the editor's "this is a tree, keep
 * the mobs a yalm off it", drawn from the mesh rather than by hand.
 *
 * Everything is on a grid of `cell` yalms in x/z. A face's footprint is sampled onto it, faces
 * within `join` of each other are one obstacle, and a ring is the outline of the cells within
 * `margin` of the obstacle's own cells.
 */
export interface Obstacle {
  /** Grid cells the steep faces stand in, as [ix, iz] at `cell` spacing. */
  cells: [number, number][];
  /** Centre of those cells, in yalms. */
  x: number;
  z: number;
  /** Where the faces meet the ground (the largest y, since y points down) and their highest point. */
  foot: number;
  top: number;
}

export interface ObstacleOptions {
  /** Vertical component of the unit normal below which a face is too steep to stand on. */
  up?: number;
  /** Grid spacing in yalms. */
  cell?: number;
  /** Faces this close, in yalms, belong to one obstacle. */
  join?: number;
  /** Which triangles to consider at all, by triangle index: the active floor, inside the region. */
  keep?: (t: number) => boolean;
  /**
   * Ground this far above an obstacle's foot that its steep faces lead onto is part of it: the
   * top of a rock, the plateau behind a cliff. Zero leaves obstacles as their steep faces only.
   */
  climb?: number;
  /** Cells never taken as obstacle ground, keyed as cellKey: where mobs were recorded. */
  avoid?: Set<number>;
}

const OFFSET = 1 << 16;
const SPAN = 1 << 17;
const keyOf = (ix: number, iz: number) => (ix + OFFSET) * SPAN + (iz + OFFSET);
/** The key of the grid cell a point falls in, for building a set of cells to keep out of rings. */
export const cellKey = (x: number, z: number, cell = 0.5) => keyOf(Math.floor(x / cell), Math.floor(z / cell));
const unkey = (k: number): [number, number] => [Math.floor(k / SPAN) - OFFSET, (k % SPAN) - OFFSET];

/**
 * The obstacles in a non-indexed triangle soup (`pos` holds x, y, z per vertex, three vertices per
 * triangle), as the zone mesh's position attribute lays them out.
 */
export function findObstacles(pos: ArrayLike<number>, opts: ObstacleOptions = {}): Obstacle[] {
  const up = opts.up ?? 0.65;
  const cell = opts.cell ?? 0.5;
  const join = Math.max(1, Math.round((opts.join ?? 1) / cell));
  const keep = opts.keep;
  const climb = opts.climb ?? 0;
  const avoid = opts.avoid;

  // Every cell a steep face passes through, with the face's height span; and, for the climb,
  // the highest walkable surface in every other cell.
  const cells = new Map<number, { foot: number; top: number; }>();
  const floors = new Map<number, number>();
  const mark = (x: number, y: number, z: number) => {
    const k = keyOf(Math.floor(x / cell), Math.floor(z / cell));
    const c = cells.get(k);
    if (c) {
      c.foot = Math.max(c.foot, y);
      c.top = Math.min(c.top, y);
    } else cells.set(k, { foot: y, top: y });
  };
  const triangles = Math.floor(pos.length / 9);
  for (let t = 0; t < triangles; t++) {
    if (keep && !keep(t)) continue;
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
    const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const steep = Math.abs(ny / len) < up;
    if (!steep && !climb) continue;
    // Sample the face densely enough that no cell it crosses is skipped.
    const longest = Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(cx - bx, cz - bz));
    const n = Math.max(1, Math.ceil(longest / (cell / 2)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const s = i / n, r = j / n;
        const x = ax + ux * s + vx * r, y = ay + uy * s + vy * r, z = az + uz * s + vz * r;
        if (steep) mark(x, y, z);
        else {
          const k = keyOf(Math.floor(x / cell), Math.floor(z / cell));
          floors.set(k, Math.min(floors.get(k) ?? Infinity, y));
        }
      }
    }
  }

  // Cells within `join` of each other are one obstacle.
  const seen = new Set<number>();
  const out: Obstacle[] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start];
    const members: number[] = [];
    while (queue.length) {
      const k = queue.pop()!;
      members.push(k);
      const [ix, iz] = unkey(k);
      for (let dz = -join; dz <= join; dz++) {
        for (let dx = -join; dx <= join; dx++) {
          const nk = keyOf(ix + dx, iz + dz);
          if (!seen.has(nk) && cells.has(nk)) {
            seen.add(nk);
            queue.push(nk);
          }
        }
      }
    }
    let foot = -Infinity, top = Infinity;
    for (const k of members) {
      const c = cells.get(k)!;
      foot = Math.max(foot, c.foot);
      top = Math.min(top, c.top);
    }
    if (climb > 0) {
      // Walk from the steep faces onto the ground they lead up to: a neighbour joins when its
      // surface carries on from where the face tops out (within a step of it) and still sits at
      // least `climb` above the obstacle's foot, so a rock's top comes with its sides while the
      // gentle slope its downhill side stands on does not. A cell a mob was recorded in ends it.
      // A rock top is a few times its own sides; a whole hillside is not. Past that budget the
      // walk was running away over open ground, and the obstacle keeps only its faces.
      const budget = members.length * 3 + Math.ceil(16 / (cell * cell));
      const taken = new Set(members);
      const climbed: number[] = [];
      const frontier: [number, number][] = members.map(k => [k, cells.get(k)!.top]);
      let overrun = false;
      while (frontier.length && !overrun) {
        const [k, level] = frontier.pop()!;
        const [ix, iz] = unkey(k);
        for (let dz = -1; dz <= 1 && !overrun; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nk = keyOf(ix + dx, iz + dz);
            if (taken.has(nk) || cells.has(nk) || avoid?.has(nk)) continue;
            const y = floors.get(nk);
            if (y === undefined || Math.abs(y - level) > 1 || y > foot - climb) continue;
            taken.add(nk);
            climbed.push(nk);
            frontier.push([nk, y]);
            if (climbed.length > budget) {
              overrun = true;
              break;
            }
          }
        }
      }
      if (!overrun) members.push(...climbed);
    }
    let sx = 0, sz = 0;
    const list: [number, number][] = [];
    for (const k of members) {
      const [ix, iz] = unkey(k);
      list.push([ix, iz]);
      sx += (ix + 0.5) * cell;
      sz += (iz + 0.5) * cell;
    }
    out.push({ cells: list, x: sx / list.length, z: sz / list.length, foot, top });
  }
  return out.sort((a, b) => b.cells.length - a.cells.length);
}

/** The obstacle whose margin ring covers a point, if any; the smallest such one wins. */
export function obstacleAt(obstacles: Obstacle[], x: number, z: number, margin: number, cell = 0.5): Obstacle | undefined {
  const reach = margin + cell;
  let best: Obstacle | undefined;
  for (const o of obstacles) {
    if (best && o.cells.length >= best.cells.length) continue;
    for (const [ix, iz] of o.cells) {
      if (Math.hypot((ix + 0.5) * cell - x, (iz + 0.5) * cell - z) <= reach) {
        best = o;
        break;
      }
    }
  }
  return best;
}

/**
 * Hole rings around obstacles: the outline of every cell within `margin` of their cells, so the
 * corners come out rounded rather than boxed. Obstacles whose margins meet come out as one ring,
 * and a pocket enclosed between them is filled, since nothing reaches it. Each vertex sits at the
 * height where the nearest obstacle meets the ground; the editor lifts it onto the terrain.
 */
export function ringsAround(list: Obstacle[], margin: number, cell = 0.5, avoid?: Set<number>): Ring[] {
  const reach = Math.ceil(margin / cell);
  const grown = new Map<number, number>(); // cell -> foot height of the obstacle it came from
  for (const o of list) {
    for (const [ix, iz] of o.cells) {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const k = keyOf(ix + dx, iz + dz);
          // A cell a mob was recorded in stays ground whatever the mesh says of it.
          if (Math.hypot(dx, dz) * cell <= margin + cell / 2 && !avoid?.has(k)) grown.set(k, o.foot);
        }
      }
    }
  }
  if (avoid?.size) {
    // Punching single sampled cells out of the ring leaves spikes and slots a cell wide. Opening
    // by one cell (erode, then grow back into nothing that is avoided) takes those off, and a
    // piece left with no obstacle cell of its own goes too.
    const has = (ix: number, iz: number) => grown.has(keyOf(ix, iz));
    const eroded = new Map<number, number>();
    for (const [k, foot] of grown) {
      const [x, z] = unkey(k);
      let solid = true;
      for (let dz = -1; dz <= 1 && solid; dz++) for (let dx = -1; dx <= 1 && solid; dx++) solid = has(x + dx, z + dz);
      if (solid) eroded.set(k, foot);
    }
    const opened = new Map<number, number>();
    for (const [k, foot] of eroded) {
      const [x, z] = unkey(k);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nk = keyOf(x + dx, z + dz);
          if (grown.has(nk)) opened.set(nk, foot);
        }
      }
    }
    // Keep only the pieces that still touch the obstacles themselves.
    const seeds = list.flatMap(o => o.cells.map(([ix, iz]) => keyOf(ix, iz))).filter(k => opened.has(k));
    const reached = new Set<number>(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const [x, z] = unkey(queue.pop()!);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nk = keyOf(x + dx, z + dz);
          if (opened.has(nk) && !reached.has(nk)) {
            reached.add(nk);
            queue.push(nk);
          }
        }
      }
    }
    grown.clear();
    for (const k of reached) grown.set(k, opened.get(k)!);
  }
  if (avoid?.size) openPockets(grown, avoid);
  return traceCells(grown, cell, list[0]?.foot ?? 0, avoid);
}

/**
 * A pocket of cells the ring would enclose that holds ground a mob was recorded on gets a
 * corridor cut out to the open, one cell wide along the shortest way, so the ring wraps around
 * that ground rather than swallowing it. A pocket with nothing recorded in it stays enclosed:
 * nothing reaches it, and the traced outline fills it.
 */
function openPockets(grown: Map<number, number>, avoid: Set<number>) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const k of grown.keys()) {
    const [x, z] = unkey(k);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  // Everything outside the grown cells within a one-cell border, flooded from the border: what
  // the flood does not reach is a pocket.
  const outside = new Set<number>();
  const queue: number[] = [];
  for (let x = minX - 1; x <= maxX + 1; x++) for (const z of [minZ - 1, maxZ + 1]) queue.push(keyOf(x, z));
  for (let z = minZ - 1; z <= maxZ + 1; z++) for (const x of [minX - 1, maxX + 1]) queue.push(keyOf(x, z));
  for (const k of queue) outside.add(k);
  while (queue.length) {
    const [x, z] = unkey(queue.pop()!);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      if (nx < minX - 1 || nx > maxX + 1 || nz < minZ - 1 || nz > maxZ + 1) continue;
      const nk = keyOf(nx, nz);
      if (outside.has(nk) || grown.has(nk)) continue;
      outside.add(nk);
      queue.push(nk);
    }
  }
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const k = keyOf(x, z);
      if (grown.has(k) || outside.has(k) || !avoid.has(k)) continue;
      // A recorded cell in a pocket: walk the shortest way out through grown cells and clear it.
      const parent = new Map<number, number>([[k, -1]]);
      const wave = [k];
      let exit = -1;
      while (wave.length && exit < 0) {
        const cur = wave.shift()!;
        const [cx, cz] = unkey(cur);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nk = keyOf(cx + dx, cz + dz);
          if (parent.has(nk)) continue;
          parent.set(nk, cur);
          if (outside.has(nk)) {
            exit = nk;
            break;
          }
          wave.push(nk);
        }
      }
      for (let at = exit; at >= 0 && at !== k; at = parent.get(at)!) {
        grown.delete(at);
        outside.add(at);
      }
      // The pocket itself is open now; mark it so the next recorded cell in it is not walked again.
      const fill = [k];
      outside.add(k);
      while (fill.length) {
        const [cx, cz] = unkey(fill.pop()!);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nk = keyOf(cx + dx, cz + dz);
          if (grown.has(nk) || outside.has(nk)) continue;
          outside.add(nk);
          fill.push(nk);
        }
      }
    }
  }
}

/**
 * The outlines of a set of grid cells (keys from cellKey, each with a height for its corners), as
 * rings. Every cell edge with no occupied neighbour is a boundary edge; shared edges cancel, and
 * what remains chains into loops. The edge order makes an outer loop wind one way and an enclosed
 * pocket the other, so the sign of the area tells them apart, and pockets are dropped: nothing
 * reaches a pocket inside an obstacle.
 */
export function traceCells(cells: Map<number, number>, cell = 0.5, fallbackY = 0, avoid?: Set<number>): Ring[] {
  const corner = (ix: number, iz: number) => keyOf(ix, iz);
  const edges = new Map<number, number>();
  const heightAt = new Map<number, number>();
  for (const [k, y] of cells) {
    const [x, z] = unkey(k);
    const add = (a: number, b: number) => {
      edges.set(a, b);
      heightAt.set(a, y);
    };
    if (!cells.has(keyOf(x, z - 1))) add(corner(x, z), corner(x + 1, z));
    if (!cells.has(keyOf(x + 1, z))) add(corner(x + 1, z), corner(x + 1, z + 1));
    if (!cells.has(keyOf(x, z + 1))) add(corner(x + 1, z + 1), corner(x, z + 1));
    if (!cells.has(keyOf(x - 1, z))) add(corner(x, z + 1), corner(x, z));
  }
  const rings: Ring[] = [];
  while (edges.size) {
    const start = edges.keys().next().value as number;
    const ring: Ring = [];
    let at = start;
    while (true) {
      const next = edges.get(at);
      if (next === undefined) break;
      edges.delete(at);
      const [x, z] = unkey(at);
      ring.push([x * cell, heightAt.get(at) ?? fallbackY, z * cell]);
      at = next;
      if (at === start) break;
    }
    if (ring.length >= 4 && signedArea(ring) > 0) rings.push(ring);
  }
  // The staircase carries nothing a mob would notice; a corner under a cell's area goes.
  return rings.map(r => (avoid?.size ? simplifyKeeping(r, cell * cell, cell, avoid) : simplifyRing(r, cell * cell)));
}

/**
 * Visvalingam simplification that never cuts across a cell to keep out of: a corner is dropped
 * only when the triangle it spans holds no avoided cell's centre, since a diagonal drawn over a
 * recorded cell would put that cell back inside the ring.
 */
function simplifyKeeping(ring: Ring, minArea: number, cell: number, avoid: Set<number>): Ring {
  const pts = ring.map(v => [...v] as Vertex);
  // The triangle a dropped corner gives up must stay clear of every avoided cell, the whole
  // cell and not just its centre: a sample sits anywhere in its cell, and a diagonal that clips
  // the cell's corner would put it inside the ring.
  const reach = cell * Math.SQRT1_2;
  const segDist = (px: number, pz: number, a: Vertex, b: Vertex) => {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const t = dx || dz ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / (dx * dx + dz * dz))) : 0;
    return Math.hypot(px - a[0] - t * dx, pz - a[2] - t * dz);
  };
  const covers = (a: Vertex, b: Vertex, c: Vertex) => {
    const minX = Math.min(a[0], b[0], c[0]) - reach, maxX = Math.max(a[0], b[0], c[0]) + reach;
    const minZ = Math.min(a[2], b[2], c[2]) - reach, maxZ = Math.max(a[2], b[2], c[2]) + reach;
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-9) return false;
    for (let ix = Math.floor(minX / cell); ix <= Math.floor(maxX / cell); ix++) {
      for (let iz = Math.floor(minZ / cell); iz <= Math.floor(maxZ / cell); iz++) {
        if (!avoid.has(keyOf(ix, iz))) continue;
        const x = (ix + 0.5) * cell, z = (iz + 0.5) * cell;
        const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
        const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
        if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return true;
        if (Math.min(segDist(x, z, a, b), segDist(x, z, b, c), segDist(x, z, c, a)) < reach) return true;
      }
    }
    return false;
  };
  const area = (i: number) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    return Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
  };
  while (pts.length > 4) {
    let best = -1, bestArea = minArea;
    for (let i = 0; i < pts.length; i++) {
      const ar = area(i);
      if (ar >= bestArea) continue;
      const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length];
      if (covers(a, pts[i], c)) continue;
      best = i;
      bestArea = ar;
    }
    if (best < 0) break;
    pts.splice(best, 1);
  }
  return pts;
}

/** The [ix, iz] a cell key stands for, the inverse of cellKey. */
export const cellOf = (key: number): [number, number] => unkey(key);
export const keyOfCell = (ix: number, iz: number) => keyOf(ix, iz);

/** The one ring around a single obstacle. */
export function ringAround(o: Obstacle, margin: number, cell = 0.5, avoid?: Set<number>): Ring {
  const rings = ringsAround([o], margin, cell, avoid);
  return rings.reduce((best, r) => (r.length > best.length ? r : best), [] as Ring);
}

const signedArea = (ring: Ring) => {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[2] - b[0] * a[2];
  }
  return sum / 2;
};

/** Area of an obstacle's footprint in square yalms, for telling a trunk from a cliff. */
export function obstacleArea(o: Obstacle, cell = 0.5): number {
  return o.cells.length * cell * cell;
}

/**
 * How much longer an obstacle is than it is wide: 1 to 2 for a rock or a trunk, well past that
 * for a cliff line or a wall, which a hole should only follow when someone means it to.
 */
export function elongation(o: Obstacle, cell = 0.5): number {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [ix, iz] of o.cells) {
    minX = Math.min(minX, ix);
    maxX = Math.max(maxX, ix);
    minZ = Math.min(minZ, iz);
    maxZ = Math.max(maxZ, iz);
  }
  const longest = (Math.max(maxX - minX, maxZ - minZ) + 1) * cell;
  return longest / Math.sqrt(obstacleArea(o, cell));
}
