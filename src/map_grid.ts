import table from "./data/map_grid.json" with { type: "json" };

/** Per zone, each map it has: floor, map number, scale, offset x, offset y. From the client. */
const MAPS: Record<string, number[][]> = table;

/** C's float-to-int conversion, which rounds toward zero rather than down. */
const trunc = Math.trunc;

/**
 * The grid square the game's <pos> prints for a spot, like "J-8", or null where it prints nothing
 * (no map for that zone or floor). `floor` is the map id the collision mesh gives the ground there,
 * the same number the client gets from its own collision check.
 *
 * GetMapPositionStr in the PS2 client: the position scaled onto the 512-pixel map sheet and shifted
 * by the map's offsets, then 32-pixel squares counted from a 16-pixel margin, A to the right and 1
 * downward. Its integer steps round toward zero, so a spot just off the top or left of the grid
 * still reads A or 1, as it does in game.
 */
export function gridPos(zone: number, floor: number | null, x: number, z: number): string | null {
  if (floor === null) return null;
  const map = MAPS[zone]?.find(m => m[0] === floor);
  if (!map) return null;
  const [, , scale, ox, oy] = map;
  const px = trunc((x * scale) / 1280 + 0.5) - ox;
  const py = -oy - trunc((z * scale) / 1280 + 0.5);
  return `${String.fromCharCode(65 + trunc((px - 16) / 32))}-${trunc((py - 16) / 32) + 1}`;
}
