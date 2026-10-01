// Where the server would put a mob spawning in a region, the way LandSandBoat's RoamRegion does it
// (src/map/roam_region.cpp): a point drawn area-weighted over the region's triangles, then snapped
// to the navmesh, and thrown away when the snap had to carry it more than kSnapTolerance sideways
// or out of the region. The server draws again, up to eight times for a roam leg and sixty-four
// when it checks a region at load, and a region none of whose draws survive is not used at all.
import { Box3, BufferAttribute, BufferGeometry, ShapeUtils, Vector2, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
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

/** The navmesh's walkable triangles, in a bounding volume tree so a snap only visits nearby ones. */
export interface NavIndex {
  bvh: MeshBVH;
}

/** The navmesh's triangle soups, one per tile, as one tree. */
export function indexNav(soups: ArrayLike<number>[]): NavIndex {
  const total = soups.reduce((n, s) => n + s.length, 0);
  const tris = new Float32Array(total);
  let at = 0;
  for (const s of soups) (tris.set(s as ArrayLike<number>, at), at += s.length);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(tris, 3));
  return { bvh: new MeshBVH(geometry) };
}

/**
 * Where Detour's findNearestPoly would put a point: the nearest point on any walkable triangle
 * whose own nearest point lies within the pick box, or null when none does.
 */
export function snapToNav(nav: NavIndex, p: Vertex): Vertex | null {
  const point = new Vector3(p[0], p[1], p[2]);
  const pick = new Box3(new Vector3(p[0] - PICK.x, p[1] - PICK.y, p[2] - PICK.z), new Vector3(p[0] + PICK.x, p[1] + PICK.y, p[2] + PICK.z));
  const q = new Vector3();
  let best: Vertex | null = null;
  let bestD = Infinity;
  nav.bvh.shapecast({
    intersectsBounds: box => box.intersectsBox(pick),
    intersectsTriangle: tri => {
      tri.closestPointToPoint(point, q);
      if (!pick.containsPoint(q)) return false;
      // Over the triangle, only height separates them; Detour ranks those by it alone too.
      const d = q.distanceToSquared(point);
      if (d < bestD) (bestD = d, best = [q.x, q.y, q.z]);
      return false;
    },
  });
  return best;
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
