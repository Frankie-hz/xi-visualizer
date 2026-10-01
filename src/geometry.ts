// Ring arithmetic on the x/z plane, shared by the region model, the obstacle scan and the editor.
// Heights ride along untouched: floors are told apart by y elsewhere, never here.
import { contours } from "d3-contour";
import { polygonArea, polygonContains, polygonHull } from "d3-polygon";
import Flatbush from "flatbush";
import type { Ring, Vertex } from "./regions.ts";

/** A ring as d3 takes it: [x, z] pairs. */
const flat = (ring: Ring): [number, number][] => ring.map(v => [v[0], v[2]]);

/** Whether x/z is inside the ring, by the even-odd rule. A point on the edge may fall either way. */
export const inRing = (ring: Ring, x: number, z: number): boolean => polygonContains(flat(ring), [x, z]);

/** Area on x/z, positive for one winding and negative for the other (d3 counts the other way round). */
export const signedArea = (ring: Ring): number => -polygonArea(flat(ring));

/** Distance from a point to the segment a-b, on x/z. */
export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = dx || dz ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz))) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

/**
 * Whether a point is inside the ring or within `tolerance` of its edge. A strict inside test puts a
 * point that lies on the edge either way, and a ring cut from another has all of its corners there.
 */
export function withinRing(ring: Ring, x: number, z: number, tolerance: number): boolean {
  if (inRing(ring, x, z)) return true;
  for (let i = 0; i < ring.length; i++) {
    const [ax, , az] = ring[i], [bx, , bz] = ring[(i + 1) % ring.length];
    if (segmentDistance(x, z, ax, az, bx, bz) <= tolerance) return true;
  }
  return false;
}

/** Shortest distance between two rings' edges, on x/z. Rings that cross are not told apart from touching. */
export function ringDistance(a: Ring, b: Ring): number {
  let best = Infinity;
  for (const [outer, inner] of [[a, b], [b, a]] as const) {
    for (const [px, , pz] of outer) {
      for (let i = 0; i < inner.length; i++) {
        const [ax, , az] = inner[i], [bx, , bz] = inner[(i + 1) % inner.length];
        best = Math.min(best, segmentDistance(px, pz, ax, az, bx, bz));
      }
    }
  }
  return best;
}

/** The convex hull of the points on x/z, as a ring of copies, wound with positive area. */
export function convexHull(points: Vertex[]): Ring {
  // d3 hands back the very pairs it was given, so each carries the index of its vertex along.
  const hull = polygonHull(points.map((v, i) => Object.assign([v[0], v[2]] as [number, number], { i })));
  if (!hull) return [];
  const ring = hull.map(p => [...points[(p as unknown as { i: number; }).i]] as Vertex);
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

/** Whether ring `a` lies mostly inside ring `b`, by the share of its vertices that do. */
export const mostlyInside = (a: Ring, b: Ring, share = 0.8) => a.filter(([x, , z]) => inRing(b, x, z)).length >= share * a.length;

/**
 * inRing for many points against the same rings: each answer per ring, from only the edges a
 * spatial index finds on the ray to the right of the point. `inside(x, z)` gives one flag per
 * ring; callers decide what outline-minus-holes means to them.
 */
export function ringsIndex(rings: Ring[]): (x: number, z: number) => Uint8Array {
  const edges: number[][] = []; // [ring, x1, z1, x2, z2]
  rings.forEach((ring, k) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) edges.push([k, ring[i][0], ring[i][2], ring[j][0], ring[j][2]]);
  });
  const flips = new Uint8Array(rings.length);
  if (!edges.length) return () => flips.fill(0);
  const index = new Flatbush(edges.length);
  for (const [, x1, z1, x2, z2] of edges) index.add(Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2));
  index.finish();
  return (x, z) => {
    flips.fill(0);
    for (const e of index.search(x, z, index.maxX, z)) {
      const [k, xi, zi, xj, zj] = edges[e];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) flips[k] ^= 1;
    }
    return flips;
  };
}

/** The height of the vertex nearest each asked-for spot, from a spatial index of the vertices. */
export function nearestHeight(vertices: Vertex[]): (x: number, z: number) => number {
  if (!vertices.length) return () => 0;
  const index = new Flatbush(vertices.length);
  for (const [x, , z] of vertices) index.add(x, z, x, z);
  index.finish();
  return (x, z) => vertices[index.neighbors(x, z, 1)[0]][1];
}

/**
 * The outlines of the filled cells of a grid, each with its holes, traced by d3-contour. In cell
 * units, cell (x, z) covering x..x+1 and z..z+1; corners come out cut at 45 degrees through the
 * middle of the cell edge, as marching squares draws them. Outlines wind with positive area.
 */
export function cellOutlines(
  width: number,
  height: number,
  filled: (x: number, z: number) => boolean,
): { outline: [number, number][]; holes: [number, number][][]; }[] {
  // A border of empty cells, so shapes touching the edge of the grid still close.
  const W = width + 2, H = height + 2;
  const values = new Array<number>(W * H).fill(0);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) if (filled(x, z)) values[(z + 1) * W + x + 1] = 1;
  const [shape] = contours().size([W, H]).smooth(false).thresholds([0.5])(values);
  const ring = (points: number[][], positive: boolean) => {
    const out = points.slice(0, -1).map(([x, z]) => [x - 1, z - 1] as [number, number]);
    const area = -polygonArea(out);
    return (area > 0) === positive ? out : out.reverse();
  };
  return shape.coordinates.map(([outline, ...holes]) => ({ outline: ring(outline, true), holes: holes.map(h => ring(h, false)) }));
}
