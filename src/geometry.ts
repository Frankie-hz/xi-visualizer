// Ring arithmetic on the x/z plane, shared by the region model, the obstacle scan and the editor.
// Heights ride along untouched: floors are told apart by y elsewhere, never here.
import type { Ring, Vertex } from "./regions.ts";

/** Whether x/z is inside the ring, by the even-odd rule. A point on the edge may fall either way. */
export function inRing(ring: Ring, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, , zi] = ring[i];
    const [xj, , zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Area on x/z, positive for one winding and negative for the other. */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[2] - b[0] * a[2];
  }
  return sum / 2;
}

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

/** The convex hull of the points on x/z, as a ring of copies. Monotone chain. */
export function convexHull(points: Vertex[]): Ring {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const cross = (o: Vertex, a: Vertex, b: Vertex) => (a[0] - o[0]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[0] - o[0]);
  const half = (list: Vertex[]) => {
    const out: Vertex[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(v => [...v] as Vertex);
}

/** Whether ring `a` lies mostly inside ring `b`, by the share of its vertices that do. */
export const mostlyInside = (a: Ring, b: Ring, share = 0.8) => a.filter(([x, , z]) => inRing(b, x, z)).length >= share * a.length;
