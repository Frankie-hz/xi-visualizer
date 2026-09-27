import { simplifyRing } from "./regions.ts";
import type { Ring } from "./regions.ts";

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
}

const OFFSET = 1 << 16;
const SPAN = 1 << 17;
const keyOf = (ix: number, iz: number) => (ix + OFFSET) * SPAN + (iz + OFFSET);
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

  // Every cell a steep face passes through, with the face's height span.
  const cells = new Map<number, { foot: number; top: number; }>();
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
    if (Math.abs(ny / len) >= up) continue;
    // Sample the face densely enough that no cell it crosses is skipped.
    const longest = Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(cx - bx, cz - bz));
    const n = Math.max(1, Math.ceil(longest / (cell / 2)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const s = i / n, r = j / n;
        mark(ax + ux * s + vx * r, ay + uy * s + vy * r, az + uz * s + vz * r);
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
    let sx = 0, sz = 0, foot = -Infinity, top = Infinity;
    const list: [number, number][] = [];
    for (const k of members) {
      const [ix, iz] = unkey(k);
      list.push([ix, iz]);
      sx += (ix + 0.5) * cell;
      sz += (iz + 0.5) * cell;
      const c = cells.get(k)!;
      foot = Math.max(foot, c.foot);
      top = Math.min(top, c.top);
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
 * A hole ring around an obstacle: the outline of every cell within `margin` of its cells, so the
 * corners are rounded rather than boxed, at the height the obstacle meets the ground.
 */
export function ringAround(o: Obstacle, margin: number, cell = 0.5): Ring {
  const reach = Math.ceil(margin / cell);
  const grown = new Set<number>();
  for (const [ix, iz] of o.cells) {
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (Math.hypot(dx, dz) * cell <= margin + cell / 2) grown.add(keyOf(ix + dx, iz + dz));
      }
    }
  }
  // Every cell edge with no occupied neighbour is a boundary edge; shared edges cancel, and what
  // remains chains into loops. The longest loop is the outline; anything inside it is enclosed by
  // the obstacle and stays out of the region with it.
  const corner = (ix: number, iz: number) => keyOf(ix, iz);
  const edges = new Map<number, number>();
  for (const k of grown) {
    const [x, z] = unkey(k);
    if (!grown.has(keyOf(x, z - 1))) edges.set(corner(x, z), corner(x + 1, z));
    if (!grown.has(keyOf(x + 1, z))) edges.set(corner(x + 1, z), corner(x + 1, z + 1));
    if (!grown.has(keyOf(x, z + 1))) edges.set(corner(x + 1, z + 1), corner(x, z + 1));
    if (!grown.has(keyOf(x - 1, z))) edges.set(corner(x, z + 1), corner(x, z));
  }
  let best: Ring = [];
  while (edges.size) {
    const start = edges.keys().next().value as number;
    const ring: Ring = [];
    let at = start;
    while (true) {
      const next = edges.get(at);
      if (next === undefined) break;
      edges.delete(at);
      const [x, z] = unkey(at);
      ring.push([x * cell, o.foot, z * cell]);
      at = next;
      if (at === start) break;
    }
    if (ring.length > best.length) best = ring;
  }
  // The staircase carries nothing a mob would notice; a corner under a cell's area goes.
  return best.length >= 4 ? simplifyRing(best, cell * cell) : best;
}

/** Area of an obstacle's footprint in square yalms, for telling a trunk from a cliff. */
export function obstacleArea(o: Obstacle, cell = 0.5): number {
  return o.cells.length * cell * cell;
}
