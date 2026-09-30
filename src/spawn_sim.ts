// Where the server would put a mob spawning in a region, the way LandSandBoat's RoamRegion does it
// (src/map/roam_region.cpp): a point drawn area-weighted over the region's triangles, then snapped
// to the navmesh, and thrown away when the snap had to carry it more than kSnapTolerance sideways
// or out of the region. The server draws again, up to eight times for a roam leg and sixty-four
// when it checks a region at load, and a region none of whose draws survive is not used at all.
import { ShapeUtils, Vector2 } from "three";
import { inRing } from "./geometry.ts";
import type { Region, Vertex } from "./regions.ts";

/** How far, in x or in z, a snap may move a point before the server calls it a different point. */
export const SNAP_TOLERANCE = 2.5;
/** Detour's largePolyPickExt: the box, in yalms either side, the snap searches for a poly in. */
const PICK = { x: 30, y: 60, z: 30 };

interface Triangle {
  a: Vertex;
  b: Vertex;
  c: Vertex;
  /** Running total of area up to and including this one, for drawing one weighted by area. */
  upTo: number;
}

/** The region cut into triangles, holes left out, each with the running area the draw picks by. */
export function triangulate(region: Region): Triangle[] {
  const rings = [region.rings[0], ...region.rings.slice(1).filter(h => h.length >= 3)];
  if ((rings[0]?.length ?? 0) < 3) return [];
  const faces = ShapeUtils.triangulateShape(
    rings[0].map(([x, , z]) => new Vector2(x, z)),
    rings.slice(1).map(h => h.map(([x, , z]) => new Vector2(x, z))),
  );
  const verts = rings.flat();
  let upTo = 0;
  return faces.map(([i, j, k]) => {
    const a = verts[i], b = verts[j], c = verts[k];
    upTo += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
    return { a, b, c, upTo };
  });
}

/** One draw, as the server makes it: a triangle by area, then a point in it by two folded weights. */
export function samplePoint(triangles: Triangle[], random: () => number = Math.random): Vertex {
  const pick = random() * triangles[triangles.length - 1].upTo;
  let lo = 0, hi = triangles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (triangles[mid].upTo < pick) lo = mid + 1;
    else hi = mid;
  }
  const { a, b, c } = triangles[lo];
  let u = random(), v = random();
  if (u + v > 1) (u = 1 - u, v = 1 - v);
  return [0, 1, 2].map(k => a[k] + u * (b[k] - a[k]) + v * (c[k] - a[k])) as Vertex;
}

/** The navmesh's walkable triangles, bucketed on x/z so a snap only looks at the ones nearby. */
export interface NavIndex {
  cell: number;
  /** Flat xyz, three vertices per triangle, in zone coordinates. */
  tris: Float32Array;
  buckets: Map<string, number[]>;
}

/** Builds the index from triangle soups: each a flat xyz list, three vertices a triangle. */
export function indexNav(soups: ArrayLike<number>[], cell = 8): NavIndex {
  const total = soups.reduce((n, s) => n + s.length, 0);
  const tris = new Float32Array(total);
  let at = 0;
  for (const s of soups) (tris.set(s as ArrayLike<number>, at), at += s.length);
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < total / 9; t++) {
    const o = t * 9;
    const xs = [tris[o], tris[o + 3], tris[o + 6]], zs = [tris[o + 2], tris[o + 5], tris[o + 8]];
    for (let ix = Math.floor(Math.min(...xs) / cell); ix <= Math.floor(Math.max(...xs) / cell); ix++) {
      for (let iz = Math.floor(Math.min(...zs) / cell); iz <= Math.floor(Math.max(...zs) / cell); iz++) {
        const key = `${ix},${iz}`;
        const list = buckets.get(key);
        if (list) list.push(t);
        else buckets.set(key, [t]);
      }
    }
  }
  return { cell, tris, buckets };
}

/** Closest point on triangle abc to p, in 3D (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: number[], a: number[], b: number[], c: number[]): number[] {
  const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = (from: number[], d: number[], t: number) => [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  return [0, 1, 2].map(k => a[k] + ab[k] * vb * denom + ac[k] * vc * denom);
}

/**
 * The nearest walkable point to p, as Detour's findNearestPoly finds it within the pick box: a
 * point standing over a triangle drops straight onto it, one beside every triangle goes to the
 * nearest edge. Null when nothing walkable is in the box.
 */
export function snapToNav(nav: NavIndex, p: Vertex): Vertex | null {
  const { cell, tris, buckets } = nav;
  let best: number[] | null = null;
  let bestD = Infinity;
  const seen = new Set<number>();
  const cx = Math.floor(p[0] / cell), cz = Math.floor(p[2] / cell);
  // Outward a ring of cells at a time; once the nearest find is closer than the next ring can
  // be, nothing further out can beat it.
  for (let ring = 0; ring <= Math.ceil(PICK.x / cell) + 1; ring++) {
    if (best && bestD <= ((ring - 1) * cell) ** 2) break;
    for (let ix = cx - ring; ix <= cx + ring; ix++) {
      for (let iz = cz - ring; iz <= cz + ring; iz++) {
        if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== ring) continue;
        for (const t of buckets.get(`${ix},${iz}`) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const o = t * 9;
          const a = [tris[o], tris[o + 1], tris[o + 2]], b = [tris[o + 3], tris[o + 4], tris[o + 5]], c = [tris[o + 6], tris[o + 7], tris[o + 8]];
          const q = closestOnTriangle(p, a, b, c);
          if (Math.abs(q[0] - p[0]) > PICK.x || Math.abs(q[1] - p[1]) > PICK.y || Math.abs(q[2] - p[2]) > PICK.z) continue;
          // Over the triangle, only height separates them; Detour ranks those by it alone too.
          const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
          if (d < bestD) (bestD = d, best = q);
        }
      }
    }
  }
  return best as Vertex | null;
}

export type Draw = { at: Vertex; ok: true; snapped: Vertex; } | { at: Vertex; ok: false; why: "no navmesh near" | "snap moved it" | "snap left the region"; };

/** Whether the server would keep a draw, and where it would put the mob if so. */
export function judge(region: Region, nav: NavIndex, at: Vertex): Draw {
  const snapped = snapToNav(nav, at);
  if (!snapped) return { at, ok: false, why: "no navmesh near" };
  if (Math.abs(snapped[0] - at[0]) > SNAP_TOLERANCE || Math.abs(snapped[2] - at[2]) > SNAP_TOLERANCE) return { at, ok: false, why: "snap moved it" };
  const inside = inRing(region.rings[0], snapped[0], snapped[2]) && !region.rings.slice(1).some(h => h.length >= 3 && inRing(h, snapped[0], snapped[2]));
  if (!inside) return { at, ok: false, why: "snap left the region" };
  return { at, ok: true, snapped };
}

/** `n` draws over the region, each judged. Empty when the region has no area to draw from. */
export function simulate(region: Region, nav: NavIndex, n: number, random: () => number = Math.random): Draw[] {
  const triangles = triangulate(region);
  if (!triangles.length || !triangles[triangles.length - 1].upTo) return [];
  return Array.from({ length: n }, () => judge(region, nav, samplePoint(triangles, random)));
}
