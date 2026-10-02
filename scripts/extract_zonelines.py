# python scripts/extract_zonelines.py [FFXI install]
#
# The zone line boxes from the client's zone DATs into src/data/zonelines.json. LandSandBoat's
# zone.yaml has only each zone line's centre; the client has the box: in a zone DAT's "RID" chunk,
# 64-byte records of position, rotation, size (each three floats) and a name. A zone line's record
# carries a second name after its own, the line it leads to ("z2s0" then "z6e3d").
#
# Ids like "z2s0" repeat from zone to zone, so each is keyed by its id and its centre rounded to a
# tenth of a yalm, which is how the editor matches it to a zone line of LandSandBoat's.
import json
import struct
import sys
from pathlib import Path

FFXI = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI")
OUT = Path(__file__).resolve().parent.parent / "src" / "data" / "zonelines.json"
NUL = b"\x00"

tables = [(FFXI / "FTABLE.DAT", FFXI / "VTABLE.DAT", FFXI / "ROM")]
for n in range(2, 10):
    f, v = FFXI / f"ROM{n}" / f"FTABLE{n}.DAT", FFXI / f"ROM{n}" / f"VTABLE{n}.DAT"
    if f.exists() and v.exists():
        tables.append((f, v, FFXI / f"ROM{n}"))
tables = [(f.read_bytes(), v.read_bytes(), rom) for f, v, rom in tables]


def dat_path(file_id: int) -> Path | None:
    for ftable, vtable, rom in tables:
        if file_id < len(vtable) and vtable[file_id]:
            value = struct.unpack_from("<H", ftable, file_id * 2)[0]
            return rom / str(value >> 7) / f"{value & 0x7F}.DAT"
    return None


def rid_chunks(path: Path):
    """The RID chunks of a DAT, walking its chunk headers: a name, then type in the low 7 bits of a
    u32 and length in 16-byte units in the rest."""
    size = path.stat().st_size
    with open(path, "rb") as f:
        at = 0
        while at + 20 <= size:
            f.seek(at)
            head = f.read(20)
            length = (struct.unpack_from("<I", head, 4)[0] >> 7) * 16
            if length < 16:
                return
            if head[16:20] == b"RID" + NUL:
                f.seek(at)
                yield f.read(length)
            at += length


def records(chunk: bytes):
    # The chunk header, the RID header, then the records to the end of the chunk.
    for at in range(16 + 64, len(chunk) - 63, 64):
        pos = struct.unpack_from("<3f", chunk, at)
        rot = struct.unpack_from("<3f", chunk, at + 12)
        size = struct.unpack_from("<3f", chunk, at + 24)
        name = chunk[at + 36 : at + 40]
        if name.isalnum():
            yield name.decode(), pos, rot, size, chunk[at + 40 : at + 44]


boxes = {}
# Zone DATs: file id 100 + zone for the first 256, and from 83635 for the zones after.
for file_id in [*range(100, 400), *range(83635, 83935)]:
    path = dat_path(file_id)
    if not path or not path.exists():
        continue
    for chunk in rid_chunks(path):
        for rid, pos, rot, size, to in records(chunk):
            if to.isalnum():
                boxes[f"{rid} {pos[0]:.1f} {pos[2]:.1f}"] = [round(v, 3) for v in (*pos, rot[1], *size)]
OUT.write_text(json.dumps(boxes, separators=(",", ":"), sort_keys=True) + "\n")
print(f"{len(boxes)} zone line boxes to {OUT}")
