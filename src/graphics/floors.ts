import * as THREE from "three";
import { mapIdPerVertex, prepareMeshData } from "./ximesh";

/**
 * Which floor everything is on, looked up by position. Buckets every triangle of the zone mesh by
 * its footprint, so a point picks the piece of ground under it rather than the one a few floors
 * up, which is the whole difficulty with a tower drawn from above.
 */
export interface FloorIndex {
  /** Map sheets with real geometry on them, in order. One entry means the zone has no floors. */
  floors: number[];
  at: (x: number, y: number, z: number) => number | null;
  perVertex: Uint8Array;
}

/** Yalms per bucket of the floor lookup. */
const CELL = 12;

export function buildFloorIndex(mesh: THREE.Mesh, prep: ReturnType<typeof prepareMeshData>): FloorIndex {
  const perVertex = mapIdPerVertex(mesh, prep);
  const pos = mesh.geometry.getAttribute("position");
  const buckets = new Map<string, { y: number; map: number; }[]>();
  const counts = new Map<number, number>();

  for (let t = 0; t < pos.count; t += 3) {
    const map = perVertex[t];
    counts.set(map, (counts.get(map) ?? 0) + 1);
    // Geometry in this scene is in zone coordinates: the flip to world space lives on the
    // scene's scale, not in the buffers, and the regions drawn over it are stored the same way.
    const x = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const y = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const z = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const key = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
    const cell = buckets.get(key);
    if (cell) cell.push({ y, map });
    else buckets.set(key, [{ y, map }]);
  }

  // Sheets carrying a handful of triangles are stray scenery, not somewhere anyone stands.
  const floors = [...counts].filter(([, n]) => n > 50).map(([map]) => map).sort((a, b) => a - b);

  return {
    floors,
    perVertex,
    at: (x, y, z) => {
      const cx = Math.round(x / CELL);
      const cz = Math.round(z / CELL);
      // Widening, because the middle of a region can be a courtyard with no floor under it at all.
      for (let ring = 1; ring <= 4; ring++) {
        let best: number | null = null;
        let nearest = Infinity;
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dz = -ring; dz <= ring; dz++) {
            for (const entry of buckets.get(`${cx + dx},${cz + dz}`) ?? []) {
              const gap = Math.abs(entry.y - y);
              if (gap < nearest) (nearest = gap, best = entry.map);
            }
          }
        }
        if (best !== null) return best;
      }
      return null;
    },
  };
}
