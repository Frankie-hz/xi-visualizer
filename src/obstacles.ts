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
  // Every cell edge with no occupied neighbour is a boundary edge; shared edges cancel, and what
  // remains chains into loops. The edge order makes an outer loop wind one way and an enclosed
  // pocket the other, so the sign of the area tells them apart.
  const corner = (ix: number, iz: number) => keyOf(ix, iz);
  const edges = new Map<number, number>();
  const footAt = new Map<number, number>();
  for (const [k, foot] of grown) {
    const [x, z] = unkey(k);
    const add = (a: number, b: number) => {
      edges.set(a, b);
      footAt.set(a, foot);
    };
    if (!grown.has(keyOf(x, z - 1))) add(corner(x, z), corner(x + 1, z));
    if (!grown.has(keyOf(x + 1, z))) add(corner(x + 1, z), corner(x + 1, z + 1));
    if (!grown.has(keyOf(x, z + 1))) add(corner(x + 1, z + 1), corner(x, z + 1));
    if (!grown.has(keyOf(x - 1, z))) add(corner(x, z + 1), corner(x, z));
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
      ring.push([x * cell, footAt.get(at) ?? list[0].foot, z * cell]);
      at = next;
      if (at === start) break;
    }
    if (ring.length >= 4 && signedArea(ring) > 0) rings.push(ring);
  }
  // The staircase carries nothing a mob would notice; a corner under a cell's area goes.
  return rings.map(r => simplifyRing(r, cell * cell));
}

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
