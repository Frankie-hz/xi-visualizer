import table from "./data/map_grid.json" with { type: "json" };

/** Per zone, each map it has: floor, map number, scale, offset x, offset y, map image. From the client. */
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

/** A map's grid laid on the zone: what the game draws over its map sheet, in zone coordinates. */
export interface MapGrid {
  /** The sixteen lines each way that bound columns A to O and rows 1 to 15, as [x1, z1, x2, z2]. */
  lines: [number, number, number, number][];
  /** The middle of every square, with the name <pos> gives it. */
  squares: { name: string; x: number; z: number; }[];
  /** Yalms across one square. */
  size: number;
}

/** The grid of the map for a zone's floor, or null where the game has none. gridPos run backwards. */
export function gridOf(zone: number, floor: number | null): MapGrid | null {
  if (floor === null) return null;
  const map = MAPS[zone]?.find(m => m[0] === floor);
  if (!map) return null;
  const [, , scale, ox, oy] = map;
  const toX = (px: number) => ((px + ox) * 1280) / scale;
  const toZ = (py: number) => (-(py + oy) * 1280) / scale;
  const lines: MapGrid["lines"] = [];
  for (let k = 0; k <= 15; k++) {
    const at = 16 + 32 * k;
    lines.push([toX(at), toZ(16), toX(at), toZ(496)], [toX(16), toZ(at), toX(496), toZ(at)]);
  }
  const squares: MapGrid["squares"] = [];
  for (let col = 0; col < 15; col++) {
    for (let row = 0; row < 15; row++) squares.push({ name: `${String.fromCharCode(65 + col)}-${row + 1}`, x: toX(32 + 32 * col), z: toZ(32 + 32 * row) });
  }
  return { lines, squares, size: (32 * 1280) / scale };
}

/** The game's map sheet for a zone's floor, and where its corners fall in zone coordinates. */
export function sheetOf(zone: number, floor: number | null): { file: string; x0: number; z0: number; x1: number; z1: number; } | null {
  if (floor === null) return null;
  const map = MAPS[zone]?.find(m => m[0] === floor);
  if (!map) return null;
  const [, number, scale, ox, oy, image] = map;
  // Map number 0 marks a zone whose image numbers are not its own; its sheets are kept by floor.
  const file = number === 0 ? `z${zone}_${floor}` : String(image);
  // The sheet's top-left pixel and its bottom-right one, the same arithmetic as the grid's.
  return { file, x0: (ox * 1280) / scale, z0: (-oy * 1280) / scale, x1: ((512 + ox) * 1280) / scale, z1: (-(512 + oy) * 1280) / scale };
}
