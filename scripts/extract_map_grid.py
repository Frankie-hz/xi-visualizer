# python scripts/extract_map_grid.py [path/to/FFXiMain.dll]
#
# Pulls the client's map table out of FFXiMain.dll into src/data/map_grid.json: for every zone and
# floor that has a map, the scale and offsets <pos> uses to turn a position into a grid square.
#
# The table is 14-byte records: zone u16, floor u8, map number u8, scale u16, key item u16,
# map image u16, offset x i16, offset y i16. The floor is the map id the collision mesh carries per
# placement (mapIdOfPlacement in src/graphics/ximesh.ts). The arithmetic is GetMapPositionStr in the
# PS2 client; see src/map_grid.ts. Each entry: floor, map number, scale, offset x, offset y, map image.
import json
import struct
import sys
from pathlib import Path

DLL = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI/FFXiMain.dll")
OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "map_grid.json"
RECORD = struct.Struct("<HBBHHHhh")
# West Ronfaure, floor 0, map 1: found by hand, and the anchor for finding the rest.
ANCHOR = bytes.fromhex("6400 00 01 0001 0100 0100 c8fe 08ff")

data = DLL.read_bytes()
at = data.find(ANCHOR)
if at < 0:
    sys.exit("West Ronfaure's map record is not in this FFXiMain.dll; the table has moved or changed shape")


def record(offset):
    zone, floor, number, scale, key_item, image, ox, oy = RECORD.unpack_from(data, offset)
    sane = 0 < zone < 1000 and floor < 64 and number < 32 and 16 <= scale <= 8192 and image < 2000 and abs(ox) < 8000 and abs(oy) < 8000
    return (zone, floor, number, scale, key_item, image, ox, oy) if sane else None


start = at
while record(start - RECORD.size):
    start -= RECORD.size
rows = []
offset = start
while row := record(offset):
    rows.append(row)
    offset += RECORD.size

grid = {}
for zone, floor, number, scale, key_item, image, ox, oy in rows:
    # No key item, no position: the client prints nothing there (the ships, for one).
    if key_item:
        grid.setdefault(str(zone), []).append([floor, number, scale, ox, oy, image])
OUT.write_text(json.dumps(grid, separators=(",", ":")) + "\n")
print(f"{sum(map(len, grid.values()))} of {len(rows)} maps over {len(grid)} zones, from offset {start:#x}, to {OUT}")
