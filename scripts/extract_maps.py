# python scripts/extract_maps.py [FFXI install]
#
# Writes the game's own map sheets to public/maps/<image>.webp, one per map image that
# src/data/map_grid.json names (run extract_map_grid.py first).
#
# A map image n is file id 0x14C0 + n, found through the FTABLE/VTABLE pairs like any DAT. On PC,
# images 230 to 293 were moved: those ids hold small icons, and the sheets sit elsewhere under their
# names, "m_<zone>_<nn>". For a zone with such an image, its images in order are paired with the
# names for that zone in order, which matches every zone where both routes reach the same file.
# Two zones' rows (Ruhotz Silvermines, Ghoyu's Reverie) carry map number 0 and image numbers that
# belong to other zones; theirs come by name too, floor by floor, saved as z<zone>_<floor>.webp.
#
# A sheet is a 512x512 8-bit paletted bitmap after a 48-byte header: the flag byte and 16-byte name,
# a BITMAPINFOHEADER, a BGRA palette with alpha out of 128, then rows bottom to top.
import json
import os
import re
import struct
import sys
from pathlib import Path

from PIL import Image

FFXI = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "maps"
OUT.mkdir(parents=True, exist_ok=True)
SHEET_SIZES = (263424, 262416)

tables = [(FFXI / "FTABLE.DAT", FFXI / "VTABLE.DAT", FFXI / "ROM")]
for n in range(2, 10):
    f, v = FFXI / f"ROM{n}" / f"FTABLE{n}.DAT", FFXI / f"ROM{n}" / f"VTABLE{n}.DAT"
    if f.exists() and v.exists():
        tables.append((f, v, FFXI / f"ROM{n}"))
tables = [(f.read_bytes(), v.read_bytes(), rom) for f, v, rom in tables]


def by_id(image: int) -> Path | None:
    file_id = 0x14C0 + image
    for ftable, vtable, rom in tables:
        if file_id < len(vtable) and vtable[file_id]:
            value = struct.unpack_from("<H", ftable, file_id * 2)[0]
            path = rom / str(value >> 7) / f"{value & 0x7F}.DAT"
            return path if path.exists() and path.stat().st_size in SHEET_SIZES else None
    return None


def by_name() -> dict[str, list[Path]]:
    """Every map sheet in the install, by the zone and number in its name ("093_01")."""
    out: dict[str, list[Path]] = {}
    for folder, _, names in os.walk(FFXI):
        for name in names:
            path = Path(folder) / name
            if path.suffix.upper() != ".DAT" or path.stat().st_size not in SHEET_SIZES:
                continue
            m = re.search(rb"m_(\d{3})_(\d\d)", path.read_bytes()[48:66])
            if m:
                out.setdefault(f"{m.group(1).decode()}_{m.group(2).decode()}", []).append(path)
    return out


def decode(data: bytes) -> Image.Image | None:
    at = 48 + 17
    width, height = struct.unpack_from("<ii", data, at + 4)
    bits = struct.unpack_from("<H", data, at + 14)[0]
    if bits != 8 or width <= 0 or height == 0:
        return None
    palette = data[at + 40 : at + 40 + 1024]
    pixels = data[at + 40 + 1024 : at + 40 + 1024 + width * abs(height)]
    rgba = bytearray()
    for i in range(256):
        b, g, r, a = palette[i * 4 : i * 4 + 4]
        rgba += bytes((r, g, b, min(255, a * 2)))
    image = Image.new("P", (width, abs(height)))
    image.putdata(pixels)
    image.putpalette(bytes(rgba), rawmode="RGBA")
    image = image.convert("RGBA")
    # A positive height is a bitmap stored bottom row first.
    return image.transpose(Image.Transpose.FLIP_TOP_BOTTOM) if height > 0 else image


grid = json.loads((ROOT / "src" / "data" / "map_grid.json").read_text())
own = {int(z): maps for z, maps in grid.items() if any(m[1] == 0 for m in maps)}
sources: dict[int | str, Path] = {}
for z, maps in grid.items():
    if int(z) in own:
        continue
    for m in maps:
        if path := by_id(m[5]):
            sources[m[5]] = path
missing = {int(z): sorted(m[5] for m in maps) for z, maps in grid.items() if int(z) not in own and any(m[5] not in sources for m in maps)}
names = by_name() if missing or own else {}
for zone, maps in own.items():
    found = [paths[0] for key, paths in sorted(names.items()) if key.startswith(f"{zone:03d}_")]
    floors = sorted(m[0] for m in maps)
    if len(found) != len(floors):
        print(f"zone {zone}: {len(floors)} floors, {len(found)} sheets by name; left out")
        continue
    for floor, path in zip(floors, found):
        sources[f"z{zone}_{floor}"] = path
if missing:
    for zone, images in missing.items():
        found = [paths[0] for key, paths in sorted(names.items()) if key.startswith(f"{zone:03d}_")]
        if len(found) != len(images):
            print(f"zone {zone}: {len(images)} map images, {len(found)} sheets by name; left out")
            continue
        for image, path in zip(images, found):
            if image in sources and sources[image] != path:
                print(f"zone {zone}: image {image} is {sources[image]} by id, {path} by name; keeping the id's")
                continue
            sources[image] = path

for old in OUT.glob("*"):
    old.unlink()
written = 0
for image, path in sorted(sources.items(), key=lambda kv: str(kv[0])):
    sheet = decode(path.read_bytes())
    if sheet is None:
        print(f"map image {image}: {path} is not an 8-bit sheet")
        continue
    sheet.save(OUT / f"{image}.webp", "WEBP", quality=80, method=6)
    written += 1
wanted = {m[5] for z, maps in grid.items() if int(z) not in own for m in maps} | {f"z{z}_{m[0]}" for z, maps in own.items() for m in maps}
total = sum(p.stat().st_size for p in OUT.glob("*.webp"))
print(f"{written} of {len(wanted)} map images written, {total / 1e6:.1f} MB in {OUT}")
