import Flatbush from "flatbush";
import * as THREE from "three";
import { mapIdPerVertex, prepareMeshData } from "./ximesh";

/**
 * Which floor everything is on, looked up by position. Indexes every triangle of the zone mesh by
 * its footprint, so a point picks the piece of ground under it rather than the one a few floors
 * up, which is the whole difficulty with a tower drawn from above.
 */
export interface FloorIndex {
  /** Map sheets with real geometry on them, in order. One entry means the zone has no floors. */
  floors: number[];
  at: (x: number, y: number, z: number) => number | null;
  perVertex: Uint8Array;
}

/** Yalms per step of the widening search around a point. */
const CELL = 12;

export function buildFloorIndex(mesh: THREE.Mesh, prep: ReturnType<typeof prepareMeshData>): FloorIndex {
  const perVertex = mapIdPerVertex(mesh, prep);
  const pos = mesh.geometry.getAttribute("position");
  const triangles = pos.count / 3;
  const ys = new Float32Array(triangles);
  const maps = new Uint8Array(triangles);
  const counts = new Map<number, number>();
  // Each triangle's middle in a spatial index. Geometry in this scene is in zone coordinates: the
  // flip to world space lives on the scene's scale, not in the buffers, and regions are stored the
  // same way.
  const index = new Flatbush(Math.max(1, triangles));
  for (let t = 0; t < pos.count; t += 3) {
    const map = perVertex[t];
    counts.set(map, (counts.get(map) ?? 0) + 1);
    const x = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const z = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    ys[t / 3] = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    maps[t / 3] = map;
    index.add(x, z, x, z);
  }
  if (!triangles) index.add(0, 0, 0, 0);
  index.finish();
  const tree = mesh.geometry.boundsTree;
  const ray = new THREE.Ray();

  // Sheets carrying a handful of triangles are stray scenery, not somewhere anyone stands.
  const floors = [...counts].filter(([, n]) => n > 50).map(([map]) => map).sort((a, b) => a - b);

  return {
    floors,
    perVertex,
    at: (x, y, z) => {
      // As the client decides it (CheckFloorNumber): the collision under the point, by a ray ten
      // yalms down from just above it, or fifteen up from just below when that finds nothing. y
      // grows downward in zone coordinates.
      const hit = (from: number, down: number, far: number) => {
        ray.origin.set(x, from, z);
        ray.direction.set(0, down, 0);
        const found = tree?.raycastFirst(ray, THREE.DoubleSide, 0, far);
        return found?.face ? perVertex[found.face.a] : null;
      };
      const under = hit(y - 1, 1, 10) ?? hit(y + 1, -1, 15);
      if (under !== null) return under;
      // Nothing there, as in a courtyard or above a hole in the mesh: the nearest ground by height,
      // widening, so a region's corner placed off the mesh still gets a floor.
      for (let ring = 1; ring <= 4 && triangles; ring++) {
        const reach = (ring + 0.5) * CELL;
        let best: number | null = null;
        let nearest = Infinity;
        for (const t of index.search(x - reach, z - reach, x + reach, z + reach)) {
          const gap = Math.abs(ys[t] - y);
          if (gap < nearest) (nearest = gap, best = maps[t]);
        }
        if (best !== null) return best;
      }
      return null;
    },
  };
}
