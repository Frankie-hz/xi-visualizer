// Heights for ring vertices, from the surfaces under them. The surfaces come from a raycast through
// the zone mesh in the editor; here they are just numbers, so the rules can be tested without one.
import type { Ring, Vertex } from "./regions.ts";

export const GROUND_SNAP = 2; // yalms; a vertex with the ground this close sits on it
export const SPIKE = 2; // yalms; a vertex this far above or below both its neighbours is never on the ground
export const SLOPE = 0.7; // rise per yalm of edge a ring may climb between two vertices: a 35-degree hillside

/**
 * Puts a ring on the ground the way the scripted pass does: a vertex with a surface within
 * GROUND_SNAP moves onto the nearest one, then no vertex may stand more than SPIKE above or
 * below both its neighbours; such a spike goes between them, onto a surface there if one is
 * within reach. Returns the ring and how many vertices moved.
 */
export function putOnGround(ring: Ring, surfacesUnder: (x: number, y: number, z: number) => number[]): [Ring, number] {
  if (ring.length < 3) return [ring, 0];
  let moved = 0;
  const stacks = ring.map(([x, y, z]) => surfacesUnder(x, y, z));
  const nearest = (st: number[], ref: number) => st.reduce((best, s) => (Math.abs(s - ref) < Math.abs(best - ref) ? s : best), Infinity);
  const out = ring.map(([x, y, z], i) => {
    const s = nearest(stacks[i], y);
    if (Math.abs(s - y) > 0.05 && Math.abs(s - y) <= GROUND_SNAP) {
      moved++;
      return [x, +s.toFixed(2), z] as Vertex;
    }
    return [x, y, z] as Vertex;
  });
  const n = out.length;
  // How far a vertex may stand from its neighbours' height: SPIKE, or more when the edges are
  // long enough for a hillside to carry it there.
  const allow = out.map(([x, , z], i) => {
    const p = out[(i + n - 1) % n], q = out[(i + 1) % n];
    return Math.max(SPIKE, SLOPE * Math.min(Math.hypot(x - p[0], z - p[2]), Math.hypot(x - q[0], z - q[2])));
  });
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (let i = 0; i < n; i++) {
      const a = out[(i + n - 1) % n][1], b = out[(i + 1) % n][1], y = out[i][1];
      if (y >= Math.min(a, b) - allow[i] && y <= Math.max(a, b) + allow[i]) continue;
      const ref = (a + b) / 2;
      const s = nearest(stacks[i], ref);
      let target: number;
      if (Math.abs(s - ref) <= SPIKE) target = s; // ground at the neighbours' level: the storey below, or under an overhang
      else if (Math.abs(nearest(stacks[i], y) - y) <= 3) continue; // on a floor of its own: the ring is climbing a ridge
      else target = ref;
      out[i] = [out[i][0], +target.toFixed(2), out[i][2]];
      moved++;
      any = true;
    }
    if (!any) break;
  }
  return [out, moved];
}
