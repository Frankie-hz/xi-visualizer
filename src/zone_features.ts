// What a zone's server files say happens where, beyond spawns: the trigger areas its Zone.lua
// registers, and its zone lines. Read from LandSandBoat, drawn over the map for reference.
import { load } from "js-yaml";
import type { Vertex } from "./regions.ts";

/** A trigger area as Zone.lua registers it. y grows downward, as everywhere in zone coordinates. */
export type TriggerArea =
  | { kind: "cuboid"; id: number; min: Vertex; max: Vertex; rotation: number; }
  | { kind: "cylinder"; id: number; x: number; z: number; radius: number; }
  | { kind: "sphere"; id: number; centre: Vertex; radius: number; };

/**
 * The trigger areas in a Zone.lua, from its zone:register...TriggerArea calls. Only calls made with
 * plain numbers can be read without running the script; the rest are counted.
 */
export function parseTriggerAreas(lua: string): { areas: TriggerArea[]; computed: number; } {
  const areas: TriggerArea[] = [];
  let computed = 0;
  for (const m of lua.matchAll(/zone:register(Cuboid|Cylindrical|Spherical)TriggerArea\(([^)]*)\)/g)) {
    const args = m[2].split(",").map(a => a.trim());
    const n = args.map(Number);
    if (!args.length || n.some(v => !Number.isFinite(v))) {
      computed++;
      continue;
    }
    if (m[1] === "Cuboid" && n.length >= 7) {
      areas.push({ kind: "cuboid", id: n[0], min: [n[1], n[2], n[3]], max: [n[4], n[5], n[6]], rotation: n[7] ?? 0 });
    } else if (m[1] === "Cylindrical" && n.length >= 4) {
      areas.push({ kind: "cylinder", id: n[0], x: n[1], z: n[2], radius: n[3] });
    } else if (m[1] === "Spherical" && n.length >= 5) {
      areas.push({ kind: "sphere", id: n[0], centre: [n[1], n[2], n[3]], radius: n[4] });
    } else computed++;
  }
  return { areas, computed };
}

/** A zone line as zone.yaml has it: where in this zone it is entered, and where it lands. */
export interface ZoneLine {
  id: string;
  /** Centre of the trigger in this zone. Its size is the client's, not in the server's files. */
  from: Vertex;
  /** The zone folder it leads to. */
  to: string;
  /** Centre of the arrival box in the destination zone, and the facing, in radians, if given. */
  at: Vertex;
  facing?: number;
  /** Arrival box size along x and z. */
  scale: [number, number];
}

/** The zone lines out of a zone, from its zone.yaml. */
export function parseZoneLines(yaml: string): ZoneLine[] {
  const doc = load(yaml) as { zonelines?: Record<string, { from?: number[]; to?: string; at?: number[]; scale?: number[]; }>; } | undefined;
  return Object.entries(doc?.zonelines ?? {}).flatMap(([id, z]) => {
    if (!z?.from || z.from.length < 3 || !z.to || !z.at || z.at.length < 3) return [];
    return [{
      id,
      from: [z.from[0], z.from[1], z.from[2]] as Vertex,
      to: z.to,
      at: [z.at[0], z.at[1], z.at[2]] as Vertex,
      ...(z.at.length > 3 ? { facing: z.at[3] } : {}),
      scale: [z.scale?.[0] ?? 1, z.scale?.[1] ?? 1] as [number, number],
    }];
  });
}

/** A zone line's trigger box as the client has it: centre, turn about the vertical, and full size. */
export interface ZoneLineBox {
  centre: Vertex;
  /** Radians about y. */
  rotation: number;
  size: Vertex;
}

/**
 * The client's box for a zone line of LandSandBoat's, from src/data/zonelines.json (see
 * scripts/extract_zonelines.py). Matched by id and centre; a centre LandSandBoat has nudged takes
 * the nearest box with the same id within a few yalms.
 */
export function zoneLineBox(line: ZoneLine, boxes: Record<string, number[]>): ZoneLineBox | null {
  const [x, , z] = line.from;
  let found = boxes[`${line.id} ${x.toFixed(1)} ${z.toFixed(1)}`];
  if (!found) {
    let near = 5;
    for (const [key, box] of Object.entries(boxes)) {
      if (!key.startsWith(`${line.id} `)) continue;
      const d = Math.hypot(box[0] - x, box[2] - z);
      if (d < near) (near = d, found = box);
    }
  }
  if (!found) return null;
  const [bx, by, bz, rotation, sx, sy, sz] = found;
  return { centre: [bx, by, bz], rotation, size: [sx, sy, sz] };
}
