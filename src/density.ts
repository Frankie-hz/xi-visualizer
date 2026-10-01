// How crowded each part of a zone is: every mob counted where it can be, a fixed spawn at its spot,
// a region's mobs spread over the region the way the server draws them, a patroller along its route.
// Smoothed into bands by d3-contour's density estimate, for drawing over the map.
import { contourDensity } from "d3-contour";
import type { Patrol, RegionSet, Spawn, Vertex } from "./regions.ts";
import { samplePoint, triangulate } from "./spawn_sim.ts";

export interface DensityBand {
  /** 0 for the faintest band up to 1 for the densest. */
  level: number;
  /** Mobs per 100 square yalms at this band's edge. */
  value: number;
  /** Polygons on x/z, each as its outline then its holes, as [x, z] pairs. */
  polygons: [number, number][][][];
}

/** Script-placed mobs sit on a placeholder until something moves them; they are nowhere yet. */
const placeholder = (at: number[]) => at.every(v => v === 1) || at.every(v => v === 0);

/**
 * Density bands for a zone's spawns. `bandwidth` is the smoothing, in yalms: around the size of a
 * camp. Each mob weighs one wherever it is spread, so the bands read as mobs at once.
 */
export function densityBands(
  spawns: Spawn[],
  regions: RegionSet,
  assign: Record<string, string[]>,
  paths: Record<string, Patrol>,
  bandwidth = 20,
  bands = 8,
): DensityBand[] {
  const points: { x: number; z: number; w: number; }[] = [];
  const triangles = new Map<string, ReturnType<typeof triangulate>>();
  let seed = 1;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const SPREAD = 24;
  for (const s of spawns) {
    const region = assign[s.id]?.[0];
    const legs = paths[s.id]?.legs;
    if (region && regions[region]) {
      const tris = triangles.get(region) ?? triangles.set(region, triangulate(regions[region])).get(region)!;
      if (!tris.length) continue;
      for (let i = 0; i < SPREAD; i++) {
        const [x, , z] = samplePoint(tris, random);
        points.push({ x, z, w: 1 / SPREAD });
      }
    } else if (legs && legs.length >= 2) {
      for (let i = 0; i < SPREAD; i++) {
        const t = (i / (SPREAD - 1)) * (legs.length - 1);
        const a: Vertex = legs[Math.floor(t)], b: Vertex = legs[Math.min(legs.length - 1, Math.floor(t) + 1)];
        const f = t - Math.floor(t);
        points.push({ x: a[0] + (b[0] - a[0]) * f, z: a[2] + (b[2] - a[2]) * f, w: 1 / SPREAD });
      }
    } else if (s.at && !placeholder(s.at)) points.push({ x: s.x, z: s.z, w: 1 });
  }
  if (!points.length) return [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) (minX = Math.min(minX, p.x), maxX = Math.max(maxX, p.x), minZ = Math.min(minZ, p.z), maxZ = Math.max(maxZ, p.z));
  const pad = bandwidth * 3;
  const [x0, z0] = [minX - pad, minZ - pad];
  const density = contourDensity<{ x: number; z: number; w: number; }>()
    .x(p => p.x - x0)
    .y(p => p.z - z0)
    .weight(p => p.w)
    .size([Math.ceil(maxX - minX + pad * 2), Math.ceil(maxZ - minZ + pad * 2)])
    .cellSize(4)
    .bandwidth(bandwidth)
    .thresholds(bands);
  const contours = density(points);
  return contours.map((c, i) => ({
    level: contours.length > 1 ? i / (contours.length - 1) : 1,
    value: c.value * 100,
    polygons: c.coordinates.map(polygon => polygon.map(ring => ring.map(([x, z]) => [x + x0, z + z0] as [number, number]))),
  }));
}
