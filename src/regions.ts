import { load } from "js-yaml";
import { difference, intersection, union } from "polyclip-ts";
import type { Geom } from "polyclip-ts";
import { cellOutlines, inRing, ringsIndex, signedArea } from "./geometry.ts";

// A vertex is [x, y, z]: earcut triangulates on x/z and carries y through, so the polygon
// describes the floor surface itself. Stacked floors are told apart by whose floor is nearer.
export type Vertex = [number, number, number];
export type Ring = Vertex[];

export interface Region {
  rings: Ring[]; // rings[0] is the outline, the rest are holes
}

export type RegionSet = Record<string, Region>;

export interface Spawn {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Raw `at:` as written, [x, y, z, rot?]. Absent once a region or a path took over placement. */
  at?: number[];
  /**
   * Regions the mob spawns and roams in. More than one means the server picks one at random on
   * every spawn, which is what `region:` taking a list means in mobs.schema.json.
   */
  regions?: string[];
  /** Patrol route. The mob spawns on the first leg, so this replaces `at:` too. */
  path?: Vertex[];
  /** Whether the route closes back on itself. Absent means true, which is yaml's `circuit:`. */
  loop?: boolean;
}

/** A spawn is placed by exactly one of these: a fixed point, a region, or a patrol route. */
export interface Patrol {
  legs: Vertex[];
  loop?: boolean;
}

// Zone ids run past 255 (Yorcia Weald is 263, Reisenjima 291), so masking to a byte aliases every
// zone above the boundary onto a classic one: Yorcia onto Attohwa Chasm, Reisenjima onto Ru'Hmet.
export function zoneOfMobId(mobId: string | number): number {
  return (Number(mobId) >> 12) & 0xfff;
}

// --- parsing ---

/**
 * A yaml file with no document in it -- empty, blank, or nothing but comments.
 *
 * js-yaml raises "expected a document, but the input is empty" for all three, and a zone nobody has
 * drawn regions for yet is exactly that: regions.yaml is absent for almost every zone, and reads
 * back as "". Absent is an answer here, not a parse failure. Real syntax errors still throw.
 */
const hasNoDocument = (text: string) => text.split("\n").every(line => !line.trim() || line.trimStart().startsWith("#"));

export function parseRegionsYaml(text: string): RegionSet {
  if (hasNoDocument(text)) return {};
  const doc = load(text) as any;
  const out: RegionSet = {};
  for (const [name, r] of Object.entries<any>(doc?.regions ?? {})) {
    out[name] = { rings: [ringOf(r?.poly ?? [], `${name}.poly`), ...listOf(r?.holes ?? [], `${name}.holes`).map((h, i) => ringOf(h, `${name}.holes[${i}]`))] };
  }
  return out;
}

/**
 * Checked as it is read, so a malformed file is refused with where it went wrong rather than
 * handed to the editor, which drew a blank map and stayed that way.
 */
const listOf = (v: unknown, where: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${where} should be a list`);
  return v;
};
const ringOf = (v: unknown, where: string): Ring =>
  listOf(v, where).map((p, i) => {
    if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(n => Number.isFinite(Number(n)))) {
      throw new Error(`${where}[${i}] should be a point, [x, y, z]`);
    }
    return [Number(p[0]), Number(p[1]), Number(p[2])] as Vertex;
  });

export function parseMobsYaml(text: string): Spawn[] {
  const doc = hasNoDocument(text) ? undefined : (load(text) as any);
  if (!doc?.spawns) throw new Error("no `spawns:` section in this file");
  return Object.entries<any>(doc.spawns).map(([id, s]) => ({
    id: String(id),
    name: s?.template ?? "unknown",
    x: s?.at?.[0] ?? 0,
    y: s?.at?.[1] ?? 0,
    z: s?.at?.[2] ?? 0,
    at: Array.isArray(s?.at) ? s.at.map(Number) : undefined,
    // A single name or a list of them. Stringifying a list would have produced "a,b", a region
    // name that exists nowhere, and written that back out over the real placement.
    regions: regionNames(s?.region),
    // `circuit:` closes back on itself, `path:` is walked out and back along the same legs.
    path: legsOf(s?.circuit ?? s?.path),
    loop: Array.isArray(s?.path) ? false : undefined,
  }));
}

const legsOf = (v: any): Vertex[] | undefined => Array.isArray(v) ? v.map((p: any) => [Number(p[0]), Number(p[1]), Number(p[2])] as Vertex) : undefined;

// --- emitting ---

const n2 = (v: number) => v.toFixed(2);
const vtx = (v: Vertex) => `[${n2(v[0])}, ${n2(v[1])}, ${n2(v[2])}]`;

// Canonical: regions sorted by name, each ring rotated to start at its smallest vertex, so a
// regenerated or re-saved file diffs cleanly against the last one.
function canonicalRing(ring: Ring): Ring {
  if (ring.length < 2) return ring;
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    const [ax, , az] = ring[i];
    const [bx, , bz] = ring[start];
    if (ax < bx || (ax === bx && az < bz)) start = i;
  }
  return [...ring.slice(start), ...ring.slice(0, start)];
}

/** `region:` is a name or a list of names; everything downstream wants the list form. */
function regionNames(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const names = value.map(String).filter(Boolean);
    return names.length ? names : undefined;
  }
  return value ? [String(value)] : undefined;
}

export function emitRegionsBlock(regions: RegionSet): string {
  const names = Object.keys(regions).sort();
  if (!names.length) return "";
  const out = ["regions:"];
  let afterHoles = false;
  for (const name of names) {
    const rings = regions[name].rings;
    // ruamel drops a blank line that follows a nested sequence, so leaving one after a region with
    // holes would fail LSB's format check. Everywhere else the blank line survives and is kept.
    if (!afterHoles) out.push("");
    afterHoles = rings.length > 1;
    out.push(`  ${name}:`);
    out.push("    poly:");
    for (const v of canonicalRing(rings[0] ?? [])) out.push(`      - ${vtx(v)}`);
    if (rings.length > 1) {
      out.push("    holes:");
      for (const hole of rings.slice(1)) {
        // ruamel's nesting, as tools/yaml/format.py in LSB writes it and its CI check demands.
        canonicalRing(hole).forEach((v, i) => out.push(`      ${i === 0 ? "-  " : "   "} - ${vtx(v)}`));
      }
    }
  }
  return out.join("\n") + "\n";
}

const SPAWN_KEY = /^ {4}([a-z_]+): +(\S.*)$/;

/**
 * Pads the `key: value` lines of one spawn to the widest key among them, which is what LSB's
 * tools/yaml/format.py does and its CI checks. Adding or removing a key can change that width, so
 * the whole entry is re-padded rather than the new line alone. Anything deeper, or a block opener,
 * ends the run exactly as the formatter's does.
 */
function alignKeys(body: string[]): string[] {
  const out = [...body];
  let run: number[] = [];
  const flush = () => {
    if (run.length) {
      const width = Math.max(...run.map(i => out[i].match(SPAWN_KEY)![1].length)) + 2;
      for (const i of run) {
        const [, key, value] = out[i].match(SPAWN_KEY)!;
        out[i] = "    " + `${key}: `.padEnd(width) + value;
      }
    }
    run = [];
  };
  for (let i = 0; i < out.length; i++) {
    if (SPAWN_KEY.test(out[i])) run.push(i);
    else flush();
  }
  flush();
  return out;
}

// --- reading back what the editor copied out ---

export interface PastedZone {
  regions: RegionSet;
  /** Only when the paste carried a mobs.yaml, which is what holds the placements. */
  spawns?: Spawn[];
}

/**
 * Reads a zone back out of text somebody kept.
 *
 * Copy YAML writes both files under `# --- name.yaml ---` headers, but what comes back is whatever
 * was saved: both files, one of them, an older copy whose regions lived in zone.yaml, or a bare
 * file with no header at all. All of those are the same work and worth accepting, so the shape is
 * worked out from the content rather than demanded of the person pasting.
 */
export function parsePastedZone(text: string): PastedZone {
  const marker = /^#\s*-+\s*(\S+?\.ya?ml).*$/gim;
  const sections: { name: string; body: string; }[] = [];
  let last: { name: string; from: number; } | null = null;

  for (const hit of text.matchAll(marker)) {
    if (last) sections.push({ name: last.name, body: text.slice(last.from, hit.index) });
    last = { name: hit[1].toLowerCase(), from: hit.index! + hit[0].length };
  }
  if (last) sections.push({ name: last.name, body: text.slice(last.from) });

  // No headers at all: one file, and which one it is is written in it.
  if (!sections.length) {
    return /^spawns:/m.test(text) ? { regions: {}, spawns: parseMobsYaml(text) } : { regions: parseRegionsYaml(text) };
  }

  // zone.yaml is where regions lived before they moved to a file of their own.
  const regionsIn = sections.find(s => s.name.includes("regions") || s.name.includes("zone"));
  const mobsIn = sections.find(s => s.name.includes("mobs"));
  return {
    regions: regionsIn ? parseRegionsYaml(regionsIn.body) : {},
    spawns: mobsIn ? parseMobsYaml(mobsIn.body) : undefined,
  };
}

// --- merging two people's work on one zone ---

/** How a spawn is placed, as the editor holds it: a region, a route, or its own fixed point. */
export interface Placement {
  regions?: string[];
  patrol?: Patrol;
}

export type Placements = Record<string, Placement>;

/** Everything about a zone that two people can disagree about. */
export interface ZoneState {
  regions: RegionSet;
  placements: Placements;
}

export interface MergeResult extends ZoneState {
  /** Named things both sides changed differently. Empty means the merge stands on its own. */
  conflicts: string[];
}

export const placementsOf = (spawns: Spawn[]): Placements =>
  Object.fromEntries(spawns.map(s => [
    s.id,
    s.regions?.length ? { regions: s.regions } : s.path ? { patrol: { legs: s.path, loop: s.loop } } : {},
  ]));

/** Placements as the editor holds them, a region list or a route per spawn, for every spawn given. */
export const placementsFrom = (spawns: Spawn[], assign: Record<string, string[]>, paths: Record<string, Patrol> = {}): Placements =>
  Object.fromEntries(spawns.map(s => [
    s.id,
    assign[s.id]?.length ? { regions: assign[s.id] } : paths[s.id] ? { patrol: paths[s.id] } : {},
  ]));

/** The other way round: placements back into the editor's region and route maps. */
export function splitPlacements(placements: Placements): { assign: Record<string, string[]>; paths: Record<string, Patrol>; } {
  const entries = Object.entries(placements);
  return {
    assign: Object.fromEntries(entries.filter(([, p]) => p.regions?.length).map(([id, p]) => [id, p.regions!])),
    paths: Object.fromEntries(entries.filter(([, p]) => p.patrol).map(([id, p]) => [id, p.patrol!])),
  };
}

// Compared through the canonical emitter rather than field by field, so a ring that was rotated or
// re-ordered without moving is recognised as unchanged instead of read as somebody's edit.
const sameRegion = (a?: Region, b?: Region) => (a ? emitRegionsBlock({ r: a }) : "") === (b ? emitRegionsBlock({ r: b }) : "");

const samePlacement = (a?: Placement, b?: Placement) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Three-way merge of one zone.
 *
 * Two people editing the same zone is the ordinary case once more than one person is drawing, and
 * the thing that must never happen is one of them quietly reverting the other. Both sides are
 * structured -- regions by name, placement by spawn id -- so most of it merges without anybody
 * being asked: whoever changed a name is the one whose version of it survives. Only a name both
 * sides moved differently is a real disagreement, and those are returned by name rather than as a
 * count, since "someone changed something" is not something anybody can act on.
 */
export function mergeZone(base: ZoneState, theirs: ZoneState, ours: ZoneState): MergeResult {
  const conflicts: string[] = [];

  const regions: RegionSet = {};
  for (const name of new Set([...Object.keys(theirs.regions), ...Object.keys(ours.regions)])) {
    const wasThere = base.regions[name];
    const mine = ours.regions[name];
    const other = theirs.regions[name];

    if (sameRegion(mine, other)) {
      if (mine) regions[name] = mine; // both did the same thing, including both deleting it
    } else if (sameRegion(mine, wasThere)) {
      if (other) regions[name] = other; // untouched here, so theirs is the newer of the two
    } else if (sameRegion(other, wasThere)) {
      if (mine) regions[name] = mine;
    } else {
      conflicts.push(`region ${name}`);
      if (mine) regions[name] = mine;
    }
  }

  const placements: Placements = {};
  for (const id of new Set([...Object.keys(theirs.placements), ...Object.keys(ours.placements)])) {
    const wasThere = base.placements[id];
    const mine = ours.placements[id];
    const other = theirs.placements[id];

    if (samePlacement(mine, other)) placements[id] = mine ?? other ?? {};
    else if (samePlacement(mine, wasThere)) placements[id] = other ?? {};
    else if (samePlacement(other, wasThere)) placements[id] = mine ?? {};
    else {
      conflicts.push(`spawn ${id}`);
      placements[id] = mine ?? {};
    }
  }

  return { regions, placements, conflicts };
}

function splitLines(text: string) {
  return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

// End of the top-level block starting at `start` (its header line included).
function blockEnd(lines: string[], start: number) {
  let i = start + 1;
  while (i < lines.length && !/^\S/.test(lines[i])) i++;
  while (i > start + 1 && lines[i - 1].trim() === "") i--; // leave trailing blank lines alone
  return i;
}

const REGIONS_HEADER = "# yaml-language-server: $schema=../../schemas/regions.schema.json";

/** Replaces (or appends) the top-level `regions:` block. Writes the whole file when there is none. */
export function patchRegionsYaml(text: string, regions: RegionSet): string {
  if (!text.trim()) {
    return Object.keys(regions).length
      ? `${REGIONS_HEADER}

${emitRegionsBlock(regions)}`
      : "";
  }
  const { lines, eol } = splitLines(text);
  const block = emitRegionsBlock(regions).split("\n").slice(0, -1);
  const at = lines.findIndex(l => /^regions:\s*$/.test(l));

  if (at >= 0) {
    lines.splice(at, blockEnd(lines, at) - at, ...block);
  } else if (block.length) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block, "");
  }
  return lines.join(eol);
}

/**
 * Rewrites how each spawn in mobs.yaml is placed: a `region:`, a `path:` of legs, or the fixed
 * `at:` point it came with. Exactly one of the three survives per entry, and `at:` is restored from
 * `positions` when a spawn goes back to being placed by hand. Line surgery on purpose: the file is
 * mostly a generated comment header plus templates we must not reformat.
 */
export function patchMobsYaml(
  text: string,
  assign: Record<string, string[]>,
  positions: Record<string, number[]> = {},
  paths: Record<string, Patrol> = {},
): string {
  const { lines, eol } = splitLines(text);
  const start = lines.findIndex(l => /^spawns:\s*$/.test(l));
  if (start < 0) throw new Error("no `spawns:` section in this file");
  const end = blockEnd(lines, start);

  const out = lines.slice(0, start + 1);
  let id: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (id === null) return;
    const named = assign[id] ?? [];
    const patrol = named.length ? undefined : paths[id];
    const placed = named.length > 0 || !!patrol;

    // Drop whatever placement the file had: the keys, plus the list items under `path:`.
    const keep: string[] = [];
    let inPath = false;
    let hadPlacement = false;
    for (const line of body) {
      if (/^\s+(path|circuit):/.test(line)) {
        inPath = hadPlacement = true;
        continue;
      }
      if (inPath) {
        if (/^\s+-/.test(line)) continue;
        inPath = false;
      }
      if (/^\s+region:/.test(line)) {
        hadPlacement = true;
        continue;
      }
      if (placed && /^\s+at:/.test(line)) continue;
      keep.push(line);
    }

    // Placement sits where `at:` sat, right after the template, which is how LSB writes it.
    const where = keep.findLastIndex(l => /^ {4}(template|script):/.test(l)) + 1;
    if (named.length) {
      // A list means the server picks one of them at random on every spawn. Written inline, the
      // way mobs.yaml already writes short string lists such as `type:` and `immune_status:`,
      // which is what tools/yaml/format.py leaves alone.
      const value = named.length === 1 ? named[0] : `[${named.join(", ")}]`;
      keep.splice(where, 0, `    region: ${value}`);
    } else if (patrol) {
      const key = patrol.loop === false ? "path" : "circuit";
      keep.splice(where, 0, `    ${key}:`, ...patrol.legs.map(v => `      - [${v.map(n => n.toFixed(3)).join(", ")}]`));
    } else if (!keep.some(l => /^ {4}at:/.test(l)) && (positions[id] || hadPlacement)) {
      // Its old spot if one is known. A mob the file only ever placed by region has none, and
      // left with neither the server has nowhere to spawn it: a placeholder at the origin keeps
      // it a valid entry, and stands out as the thing still to be placed. A mob the file never
      // placed -- spawned by a script, say -- is left as it was.
      const at = (positions[id] ?? [0, 0, 0.1]).map((n, i) => (i < 3 ? n.toFixed(3) : String(n))).join(", ");
      keep.splice(where, 0, `    at: [${at}]`);
    }

    out.push(...alignKeys(keep));
    id = null;
    body = [];
  };

  for (let i = start + 1; i < end; i++) {
    const entry = lines[i].match(/^ {2}(\d+):\s*$/);
    if (entry) {
      flush();
      id = entry[1];
      out.push(lines[i]);
    } else if (id !== null) {
      body.push(lines[i]);
    } else {
      out.push(lines[i]);
    }
  }
  flush();
  out.push(...lines.slice(end));
  return out.join(eol);
}

// --- geometry ---

/** Inside the outline and not inside a hole. Purely horizontal: floors are told apart by y. */
export function containsXZ(r: Region, x: number, z: number): boolean {
  if (!r.rings[0] || r.rings[0].length < 3 || !inRing(r.rings[0], x, z)) return false;
  return !r.rings.slice(1).some(h => inRing(h, x, z));
}

/** containsXZ for many points against one region, through a spatial index of its edges. */
export function containmentTest(r: Region): (x: number, z: number) => boolean {
  if (!r.rings[0] || r.rings[0].length < 3) return () => false;
  const inside = ringsIndex(r.rings.map(ring => (ring.length >= 3 ? ring : [])));
  return (x, z) => {
    const flips = inside(x, z);
    return flips[0] === 1 && !flips.some((f, k) => k > 0 && f === 1);
  };
}

// ponytail: nearest outline vertex, not barycentric interpolation over the triangulation.
// Floors are flat enough that this picks the right one; upgrade if a sloped stacked region misbehaves.
export function floorYAt(r: Region, x: number, z: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (const [vx, vy, vz] of r.rings[0] ?? []) {
    const d = (vx - x) ** 2 + (vz - z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = vy;
    }
  }
  return best;
}

function spanXZ(r: Region): number {
  const ring = r.rings[0] ?? [];
  if (!ring.length) return Infinity;
  const xs = ring.map(v => v[0]);
  const zs = ring.map(v => v[2]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
}

/** Floors are 10+ yalms apart, so anything this close to the nearest one counts as the same floor. */
const SAME_FLOOR = 5;

/**
 * Region at a point: horizontal containment, then the nearest floor, and among regions sharing that
 * floor the smallest one. Smallest-wins is what makes a region nested inside another clickable at
 * all, since the bigger one covers every point the smaller one does.
 */
export function regionAt(regions: RegionSet, x: number, z: number, y: number): string | null {
  const over = Object.entries(regions)
    .filter(([, r]) => containsXZ(r, x, z))
    .map(([name, r]) => ({ name, dy: Math.abs(floorYAt(r, x, z) - y), span: spanXZ(r) }));
  if (!over.length) return null;

  const nearest = Math.min(...over.map(c => c.dy));
  return over
    .filter(c => c.dy <= nearest + SAME_FLOOR)
    .reduce((a, b) => (a.span <= b.span ? a : b))
    .name;
}

/**
 * Visvalingam-Whyatt: repeatedly drop the vertex whose triangle with its neighbours is smallest,
 * until every remaining one covers more than `minArea` square yalms. Keeps the shape's silhouette
 * where a distance-based filter would flatten curves.
 */
export function simplifyRing(ring: Ring, minArea = 4, keep = 3): Ring {
  // ponytail: recomputes areas each pass instead of keeping a heap, fine for a few hundred vertices.
  const out = ring.slice();
  const areaAt = (i: number) => {
    const [ax, , az] = out[(i - 1 + out.length) % out.length];
    const [bx, , bz] = out[i];
    const [cx, , cz] = out[(i + 1) % out.length];
    return Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  };
  while (out.length > Math.max(3, keep)) {
    let worst = 0;
    let worstArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = areaAt(i);
      if (a < worstArea) {
        worstArea = a;
        worst = i;
      }
    }
    if (worstArea > minArea) break;
    out.splice(worst, 1);
  }
  return out;
}

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** Capture time in seconds. Absent means the samples are assumed to be one unbroken run. */
  t?: number;
}

/** Perpendicular distance in x/z from p to the segment ab. */
function perpDistance(a: Vertex, b: Vertex, p: Vertex): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[2] - (a[2] + t * dz));
}

/**
 * Douglas-Peucker for an open line: the ends are fixed, and a point survives when dropping it would
 * pull the line more than `tolerance` yalms away from it. `max` legs is a ceiling, met by loosening
 * the tolerance until it fits.
 *
 * Not Visvalingam, which is what regions use: a patrol that walks out and back doubles over itself,
 * and the triangle at the turn is degenerate, so area ranks the one vertex that defines the route as
 * the most disposable point on it. Removing it collapses the whole excursion. Perpendicular distance
 * ranks that same vertex first instead, which is the only correct answer for a route.
 */
export function simplifyLine(points: Vertex[], tolerance = 4, max = Infinity): Vertex[] {
  if (points.length <= 2) return points.slice();

  const thin = (limit: number) => {
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const spans: [number, number][] = [[0, points.length - 1]];
    while (spans.length) {
      const [from, to] = spans.pop()!;
      let far = -1;
      let worst = limit;
      for (let i = from + 1; i < to; i++) {
        const d = perpDistance(points[from], points[to], points[i]);
        if (d > worst) {
          worst = d;
          far = i;
        }
      }
      if (far < 0) continue;
      keep[far] = 1;
      spans.push([from, far], [far, to]);
    }
    return points.filter((_, i) => keep[i]);
  };

  let limit = tolerance;
  let out = thin(limit);
  while (out.length > max) out = thin(limit *= 1.5);
  return out;
}

export interface TracedRoute {
  legs: Vertex[];
  /** Fraction of the trail that sits on the route. A mob walking a beat scores near 1. */
  coverage: number;
}

const trailExtent = (run: TrailPoint[]) => {
  const xs = run.map(p => p.x);
  const zs = run.map(p => p.z);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
};

/**
 * The trail split into unbroken captures. Samples arrive a few seconds apart while someone is
 * watching the mob and then stop for minutes, so consecutive entries in the file are not
 * necessarily consecutive positions: a leg drawn across that boundary crosses ground nobody saw
 * the mob walk. Rates differ per mob, from four seconds to well over a minute, so the threshold
 * comes from the mob's own median rather than a fixed number of seconds.
 */
function capturesOf(points: TrailPoint[]): TrailPoint[][] {
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) steps.push((points[i].t ?? 0) - (points[i - 1].t ?? 0));
  const typical = [...steps].sort((a, b) => a - b)[steps.length >> 1] || 0;
  const maxStep = Math.max(20, typical * 6);

  const out: TrailPoint[][] = [];
  let run: TrailPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const jumped = points[i].t === undefined
      ? (points[i].x - points[i - 1].x) ** 2 + (points[i].z - points[i - 1].z) ** 2 > 50 * 50
      : steps[i - 1] > maxStep;
    if (jumped) {
      out.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  out.push(run);
  return out.filter(r => r.length >= 8);
}

/**
 * Stretches of one capture that might each be a circuit: from a point until the mob has gone well
 * away and come back near it.
 *
 * On its own this cuts the circuit in the wrong place. A route that passes close to its own start
 * partway round gets split there, and the piece past the split is missing from every lap, so the
 * traced route comes up short by the same section every time. Hence the periods below.
 */
function lapsOf(run: TrailPoint[], close: number): TrailPoint[][] {
  const flat = (a: TrailPoint, b: TrailPoint) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
  const out: TrailPoint[][] = [];
  let from = 0;
  let away = false;
  for (let i = 1; i < run.length; i++) {
    const d2 = flat(run[i], run[from]);
    if (!away) away = d2 > (close * 3) ** 2;
    else if (d2 < close * close) {
      out.push(run.slice(from, i + 1));
      from = i;
      away = false;
    }
  }
  return out.filter(lap => lap.length >= 4 && trailExtent(lap) >= close * 4);
}

/**
 * Windows of one circuit each, found as the repeat period of a capture: the sample lag at which the
 * mob is most often back where it was. This finds the whole circuit including any spur, which the
 * laps above can miss, and it costs one pass per candidate lag.
 *
 * The median, not the mean, because one excursion would otherwise drag every lag's score alike.
 */
function periodWindows(run: TrailPoint[], close: number): TrailPoint[][] {
  const n = run.length;
  const maxLag = Math.min(800, Math.floor(n / 3));
  if (maxLag < 10) return [];

  const scored: { lag: number; offset: number; }[] = [];
  for (let lag = 10; lag <= maxLag; lag++) {
    const offsets: number[] = [];
    const step = Math.max(1, Math.floor((n - lag) / 120));
    for (let i = 0; i < n - lag; i += step) {
      offsets.push(Math.hypot(run[i].x - run[i + lag].x, run[i].z - run[i + lag].z));
    }
    offsets.sort((a, b) => a - b);
    scored.push({ lag, offset: offsets[offsets.length >> 1] });
  }
  scored.sort((a, b) => a.offset - b.offset);

  const out: TrailPoint[][] = [];
  for (const { lag } of scored.slice(0, 4)) {
    for (const at of [0, 0.25, 0.5, 0.75]) {
      const window = closedCircuit(run, Math.floor((n - lag - 1) * at), lag, close);
      if (window) out.push(window);
    }
  }
  return out;
}

/**
 * The samples from a start index up to wherever the mob next comes back to that spot, give or take
 * a quarter of the lag. A lag is only a rough period, so the window it cuts does not land back
 * exactly where it started, and a route whose ends do not meet closes itself with a leg straight
 * across open ground. Nothing near the start means the stretch is not a circuit and holds no route.
 */
function closedCircuit(run: TrailPoint[], from: number, lag: number, close: number): TrailPoint[] | null {
  let end = -1;
  let nearest = (close * 2) ** 2;
  for (let i = Math.floor(from + lag * 0.75); i <= Math.min(from + lag * 1.25, run.length - 1); i++) {
    const d2 = (run[i].x - run[from].x) ** 2 + (run[i].z - run[from].z) ** 2;
    if (d2 < nearest) {
      nearest = d2;
      end = i;
    }
  }
  return end < 0 ? null : run.slice(from, end + 1);
}

/**
 * Traces a patrol route out of a mob's recorded trail: the samples are in capture order, so a route
 * is the points joined up in that order and thinned only enough to be editable. Every candidate
 * circuit is scored by how much of the whole trail lands on it and the best one wins, since a mob
 * walking a beat stays on it while a wanderer leaves most of its trail off to one side. The score
 * comes back with the route, so the caller can say how well it fits rather than implying that a
 * traced route is necessarily a real one.
 */
export function routeFromTrail(points: TrailPoint[], close = 8): TracedRoute | null {
  if (points.length < 30) return null;

  const stride = Math.max(1, Math.floor(points.length / 400));
  const sampled: TrailPoint[] = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);

  const coverageOf = (legs: Vertex[]) => sampled.filter(p => distanceToRoute(legs, p) <= close * 1.5).length / sampled.length;

  // A route may only run where the mob was seen walking. A candidate that spans a break in the
  // capture is fine when the mob picked its beat back up where it left off, and not fine when it
  // came back somewhere else: the difference is whether the leg between them covers ground that has
  // samples on it, which is what this checks, rather than whether a break is in the window at all.
  const onGround = (legs: Vertex[]) =>
    legs.every((v, i) => {
      const next = legs[(i + 1) % legs.length];
      return [0.25, 0.5, 0.75].every(t => {
        const x = v[0] + (next[0] - v[0]) * t;
        const z = v[2] + (next[2] - v[2]) * t;
        return sampled.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 <= (close * 2) ** 2);
      });
    });

  const candidates: TrailPoint[][] = [];
  for (const run of [...capturesOf(points), points]) {
    // The capture itself, for when the mob got round once before anyone lost sight of it. Whether
    // that is a circuit or one aimless walk is not decided here: coverage below settles it, since a
    // beat the mob repeats explains the rest of the trail and a one-off walk does not.
    const whole = closedCircuit(run, 0, run.length - 1, close);
    if (whole) candidates.push(whole);
    candidates.push(...lapsOf(run, close), ...periodWindows(run, close));
  }

  let best: TracedRoute | null = null;
  for (const candidate of candidates) {
    if (trailExtent(candidate) < close * 5) continue; // a mob milling about on the spot has no route
    const legs = simplifyLine(candidate.map(p => [p.x, p.y, p.z] as Vertex), 2, 64);
    if (legs.length < 3 || !onGround(legs)) continue;
    const coverage = coverageOf(legs);
    if (!best || coverage > best.coverage) best = { legs, coverage };
  }
  // Below this the trail is a blob the route happens to cross, not a beat the mob walks.
  return best && best.coverage >= 0.6 ? best : null;
}

/** Shortest distance in x/z from a point to a closed route. */
function distanceToRoute(legs: Vertex[], p: TrailPoint): number {
  let best = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const [ax, , az] = legs[i];
    const [bx, , bz] = legs[(i + 1) % legs.length];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.z - (az + t * dz)));
  }
  return best;
}

// Positive for an outline, negative for a hole, given the edge order emitted below.

/**
 * Builds regions covering a set of roam points: rasterise onto a grid, grow by one cell so gaps
 * between samples close, then trace the outline of the occupied cells. A raster follows concave
 * shapes and yields holes for free, which no hull can do. Vertex heights come from the points
 * themselves, so each polygon lands on the floor the mobs were standing on.
 *
 * One region per connected cluster, biggest first: mobs of a kind often live in several separate
 * camps, and a single polygon around all of them would cover everything in between.
 */
export function regionsFromPoints(points: TrailPoint[], cell = 6, close = 2): Region[] {
  if (points.length < 3) return [];

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const pad = close + 3; // keeps the grown shape clear of the grid border
  const w = Math.ceil((maxX - minX) / cell) + pad * 2 + 1;
  const key = (x: number, z: number) => z * w + x;

  const heights = new Map<number, [number, number]>(); // cell -> [y sum, count]
  const filled = new Set<number>();
  for (const p of points) {
    const k = key(Math.floor((p.x - minX) / cell) + pad, Math.floor((p.z - minZ) / cell) + pad);
    filled.add(k);
    const acc = heights.get(k);
    if (acc) (acc[0] += p.y, acc[1]++);
    else heights.set(k, [p.y, 1]);
  }

  const dilate = (src: Set<number>, by: number) => {
    let out = src;
    for (let step = 0; step < by; step++) {
      const next = new Set(out);
      for (const k of out) {
        const x = k % w;
        const z = (k - x) / w;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) next.add(key(x + dx, z + dz));
        }
      }
      out = next;
    }
    return out;
  };
  const erode = (src: Set<number>, by: number) => {
    let out = src;
    for (let step = 0; step < by; step++) {
      const next = new Set<number>();
      for (const k of out) {
        const x = k % w;
        const z = (k - x) / w;
        let solid = true;
        for (let dz = -1; dz <= 1 && solid; dz++) {
          for (let dx = -1; dx <= 1 && solid; dx++) solid = out.has(key(x + dx, z + dz));
        }
        if (solid) next.add(k);
      }
      out = next;
    }
    return out;
  };

  // Close the shape (grow then shrink) so gaps between samples and between nearby camps join up
  // without inflating the outline, then grow once more so every sampled point sits inside it.
  const grown = dilate(erode(dilate(filled, close + 1), close), 1);

  // Height at a corner: whichever of the cells around it were actually visited, widening the search
  // a little because the boundary sits on grown cells rather than sampled ones.
  const fallback = points.reduce((s, p) => s + p.y, 0) / points.length;
  const heightAt = (x: number, z: number) => {
    for (let radius = 1; radius <= 3; radius++) {
      let sum = 0;
      let n = 0;
      for (let dz = -radius; dz < radius; dz++) {
        for (let dx = -radius; dx < radius; dx++) {
          const acc = heights.get(key(x + dx, z + dz));
          if (acc) (sum += acc[0], n += acc[1]);
        }
      }
      if (n) return sum / n;
    }
    return fallback;
  };

  // Traced by d3-contour, each outline with its holes. Specks a few cells across are sampling noise,
  // and the staircase along the boundary carries no information.
  const h = Math.ceil((maxZ - minZ) / cell) + pad * 2 + 1;
  const speck = cell * cell * 4;
  const toZone = (ring: [number, number][]): Ring =>
    ring.map(([x, z]) => [minX + (x - pad) * cell, heightAt(Math.round(x), Math.round(z)), minZ + (z - pad) * cell] as Vertex);
  const smooth = (r: Ring) => simplifyRing(r, cell * cell * 4);
  return cellOutlines(w, h, (x, z) => grown.has(key(x, z)))
    .map(({ outline, holes }) => ({ outline: toZone(outline), holes: holes.map(toZone) }))
    .filter(({ outline }) => signedArea(outline) >= speck)
    .sort((a, b) => signedArea(b.outline) - signedArea(a.outline))
    .map(({ outline, holes }) => ({ rings: [smooth(outline), ...holes.filter(h => -signedArea(h) >= speck).map(smooth)] }));
}

/**
 * Rewrites a region as shapes that are actually valid: an outline that crosses itself becomes the
 * pieces it really describes, and the holes are cut out of it rather than merely listed after it.
 * A bowtie is two triangles and not one region, so this returns a list.
 *
 * Dragging a vertex across an edge is all it takes to make a ring that crosses itself, and the
 * review tab could only ever point at one. Clipping is the one piece of geometry here worth handing
 * to a library: the sweep line handling every way edges can meet is not something to hand roll.
 *
 * Heights come back from the nearest original vertex, since the corners the clipper invents where
 * edges cross are new points that no sample ever stood on.
 */
export function repairRegion(r: Region): Region[] {
  const outline = r.rings[0] ?? [];
  if (outline.length < 3) return [];
  let shape = union(flat(outline));
  const holes = r.rings.slice(1).filter(hole => hole.length >= 3);
  if (holes.length) shape = difference(shape, ...holes.map(flat));
  return regionsOf(shape, r.rings.flat());
}

/**
 * The ground `a` covers that `b` does not, as regions of its own. Both ways round, this is what a
 * reshape did: the area it gave up and the area it took in, which the two outlines drawn over
 * each other only imply.
 */
export function regionDifference(a: Region, b: Region): Region[] {
  if ((a.rings[0]?.length ?? 0) < 3) return [];
  if ((b.rings[0]?.length ?? 0) < 3) return [a];
  // Heights from `a` alone: the ground is `a`'s, and a vertex `b` had that `a` dropped -- a notch
  // in a wall, say -- is exactly the height this ground must not borrow.
  return regionsOf(difference(asGeom(a), asGeom(b)), a.rings.flat());
}

/** The ground `a` and `b` both cover: what cutting `a` out of `b` would take away. Heights from `b`. */
export function regionIntersection(a: Region, b: Region): Region[] {
  if ((a.rings[0]?.length ?? 0) < 3 || (b.rings[0]?.length ?? 0) < 3) return [];
  return regionsOf(intersection(asGeom(a), asGeom(b)), b.rings.flat());
}

const flat = (ring: Ring): Geom => [ring.map(v => [v[0], v[2]] as [number, number])];

/** A region as the clipper sees it: its outline with its holes, flattened onto x/z. */
function asGeom(r: Region): Geom {
  const holes = r.rings.slice(1).filter(hole => hole.length >= 3);
  return holes.length ? difference(flat(r.rings[0]), ...holes.map(flat)) : flat(r.rings[0]);
}

/**
 * Clipper output back into regions. Heights come back from the nearest known vertex, since the
 * corners the clipper invents where edges cross are new points that no sample ever stood on.
 */
function regionsOf(shape: Geom, known: Vertex[]): Region[] {
  const heightAt = (x: number, z: number) => {
    let best = known[0]?.[1] ?? 0;
    let nearest = Infinity;
    for (const v of known) {
      const d = (v[0] - x) ** 2 + (v[2] - z) ** 2;
      if (d < nearest) (nearest = d, best = v[1]);
    }
    return best;
  };
  // A single polygon comes back as ring[], several as ring[][]; the clipper gives whichever fits.
  const polygons = (typeof shape[0]?.[0]?.[0] === "number" ? [shape] : shape) as [number, number][][][];
  return polygons.map(polygon => ({
    rings: polygon.map(ring => {
      // The clipper repeats the first vertex to close a ring; ours are closed by being rings.
      const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1)
        : ring;
      return open.map(([x, z]) => [x, heightAt(x, z), z] as Vertex);
    }),
  })).filter(out => (out.rings[0]?.length ?? 0) >= 3);
}

// ponytail: O(n^2) edge pairs, fine for the few dozen vertices a simplified region carries.
export function selfIntersects(ring: Ring): boolean {
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => Math.sign((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j || (i + 1) % n === j || (j + 1) % n === i) continue;
      const [ax, , az] = ring[i];
      const [bx, , bz] = ring[(i + 1) % n];
      const [cx, , cz] = ring[j];
      const [dx, , dz] = ring[(j + 1) % n];
      const d1 = cross(ax, az, bx, bz, cx, cz);
      const d2 = cross(ax, az, bx, bz, dx, dz);
      const d3 = cross(cx, cz, dx, dz, ax, az);
      const d4 = cross(cx, cz, dx, dz, bx, bz);
      if (d1 !== d2 && d3 !== d4) return true;
    }
  }
  return false;
}

// --- diffing two versions of a zone ---

/** Outline area minus its holes, in square yalms. */
export function regionArea(r: Region): number {
  const outer = Math.abs(signedArea(r.rings[0] ?? []));
  const holes = r.rings.slice(1).reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
  return Math.max(0, outer - holes);
}

export interface RegionChange {
  name: string;
  fromVertices: number;
  toVertices: number;
  /** head area / base area, so 1.18 means the region grew by 18%. */
  areaRatio: number;
  /** Holes each side has. A region can change by nothing but these -- the outline untouched to the
   * vertex and a hole cut out of it -- and describing only the outline then reports no change at
   * all on a row whose whole job is saying what changed. */
  fromHoles: number;
  toHoles: number;
}

export interface SpawnMove {
  id: string;
  name: string;
  from?: string;
  to?: string;
}

/** A mob whose route changed: given one, lost one, or walking different legs. */
export interface SpawnRoute {
  id: string;
  name: string;
  /** Legs before and after; 0 is no route. */
  fromLegs: number;
  toLegs: number;
}

export interface RegionsDiff {
  added: string[];
  removed: string[];
  reshaped: RegionChange[];
  unchanged: string[];
  moved: SpawnMove[];
  /** Mobs whose route changed. Not a region change, but a change to where the mob goes. */
  rerouted: SpawnRoute[];
  /** Mobs still on a fixed point, with that point moved. */
  relocated: { id: string; name: string; }[];
  addedSpawns: string[];
  removedSpawns: string[];
}

export interface ZoneSide {
  regions: RegionSet;
  spawns: Spawn[];
}

/**
 * What changed between two versions of a zone. Shapes are compared through the canonical emitter,
 * so a difference here is a difference that would show up in the file rather than float noise.
 */
export function diffRegions(base: ZoneSide, head: ZoneSide): RegionsDiff {
  const shape = (r: Region) => emitRegionsBlock({ r });
  const names = new Set([...Object.keys(base.regions), ...Object.keys(head.regions)]);

  const diff: RegionsDiff = { added: [], removed: [], reshaped: [], unchanged: [], moved: [], rerouted: [], relocated: [], addedSpawns: [], removedSpawns: [] };
  const route = (s: Spawn) => (s.path ? JSON.stringify([s.path, s.loop ?? false]) : "");
  for (const name of [...names].sort()) {
    const before = base.regions[name];
    const after = head.regions[name];
    if (!before) diff.added.push(name);
    else if (!after) diff.removed.push(name);
    else if (shape(before) === shape(after)) diff.unchanged.push(name);
    else {
      diff.reshaped.push({
        name,
        fromVertices: before.rings[0]?.length ?? 0,
        toVertices: after.rings[0]?.length ?? 0,
        areaRatio: regionArea(before) ? regionArea(after) / regionArea(before) : Infinity,
        fromHoles: Math.max(0, before.rings.length - 1),
        toHoles: Math.max(0, after.rings.length - 1),
      });
    }
  }

  const baseSpawns = new Map(base.spawns.map(s => [s.id, s]));
  const headSpawns = new Map(head.spawns.map(s => [s.id, s]));
  for (const [id, after] of headSpawns) {
    const before = baseSpawns.get(id);
    if (!before) diff.addedSpawns.push(id);
    else {
      const was = (before.regions ?? []).join(", ");
      const now = (after.regions ?? []).join(", ");
      if (was !== now) {
        diff.moved.push({ id, name: after.name, from: was || undefined, to: now || undefined });
      }
      if (route(before) !== route(after)) {
        diff.rerouted.push({ id, name: after.name, fromLegs: before.path?.length ?? 0, toLegs: after.path?.length ?? 0 });
      } else if (!was && !now && !after.path && before.at && after.at && before.at.join() !== after.at.join()) {
        diff.relocated.push({ id, name: after.name });
      }
    }
  }
  for (const id of baseSpawns.keys()) {
    if (!headSpawns.has(id)) diff.removedSpawns.push(id);
  }
  const byName = (a: { name: string; id: string; }, b: { name: string; id: string; }) => a.name.localeCompare(b.name) || Number(a.id) - Number(b.id);
  diff.moved.sort(byName);
  diff.rerouted.sort(byName);
  diff.relocated.sort(byName);
  return diff;
}

/**
 * The commit for a zone: a title that says what was done, and the changeset under it.
 *
 * The title used to count what the zone holds -- "3 regions, 42 spawns placed" -- which reads the
 * same whether one vertex moved or the whole zone was redrawn. Reviewers read the title in a list
 * of commits; the names go below, where whoever needs them can find them.
 */
export function commitMessage(zone: string, before: ZoneSide, after: ZoneSide): string {
  const d = diffRegions(before, after);
  const n = (count: number, thing: string) => `${count} ${thing}${count === 1 ? "" : "s"}`;

  // Route changes are not a region diff, but they are what the commit did.
  const routed = d.rerouted;

  // Marks rather than words, as the diff page writes them: a title naming all three kinds of
  // region change in full runs past what GitHub shows of a title.
  const title: string[] = [];
  const marks = [[d.added.length, "+"], [d.removed.length, "-"], [d.reshaped.length, "~"]] as const;
  const touched = marks.reduce((sum, [c]) => sum + c, 0);
  if (touched) title.push(`${marks.filter(([c]) => c).map(([c, mark]) => `${mark}${c}`).join(" ")} region${touched === 1 ? "" : "s"}`);
  if (d.moved.length) title.push(`${n(d.moved.length, "spawn")} placed`);
  if (routed.length) title.push(`${n(routed.length, "route")} changed`);

  const body: string[] = [];
  if (d.added.length) body.push(`Added: ${d.added.join(", ")}`);
  if (d.removed.length) body.push(`Removed: ${d.removed.join(", ")}`);
  for (const c of d.reshaped) {
    const notes: string[] = [];
    if (c.fromVertices !== c.toVertices) notes.push(`${c.fromVertices} -> ${c.toVertices} vertices`);
    if (Math.abs(c.areaRatio - 1) > 0.005) notes.push(`area ${c.areaRatio >= 1 ? "+" : ""}${((c.areaRatio - 1) * 100).toFixed(0)}%`);
    if (c.toHoles !== c.fromHoles) notes.push(`${c.fromHoles} -> ${c.toHoles} holes`);
    body.push(`Reshaped ${c.name}${notes.length ? ` (${notes.join(", ")})` : ""}`);
  }
  const into = new Map<string, string[]>();
  for (const m of d.moved) {
    const key = m.to ?? "no region";
    into.set(key, [...(into.get(key) ?? []), `${m.name} ${m.id}${m.from ? ` (was ${m.from})` : ""}`]);
  }
  for (const [to, who] of into) body.push(`Placed in ${to}: ${who.join(", ")}`);
  if (routed.length) body.push(`Routes: ${routed.map(s => `${s.name} ${s.id}`).join(", ")}`);

  return `${zone}: ${title.join(", ") || "regions updated"}${body.length ? `\n\n${body.join("\n")}` : ""}`;
}

// --- review ---

export interface Finding {
  level: "error" | "warn" | "info";
  text: string;
  /** Set on findings with a mechanical fix, so the list can offer it without reading the text. */
  code?: "self-intersects";
  region?: string;
  spawnId?: string;
}

/**
 * What is wrong with a zone as it stands. `paths` is the routes as edited; without it the routes
 * the spawns were loaded with are checked, which after any route edit is checking the wrong thing.
 */
export function validate(regions: RegionSet, spawns: Spawn[], assign: Record<string, string[]>, paths?: Record<string, Patrol>): Finding[] {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  // A spawn naming several regions counts towards each: it can be in any of them.
  for (const names of Object.values(assign)) {
    for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  }

  for (const [name, r] of Object.entries(regions)) {
    r.rings.forEach((ring, i) => {
      if (ring.length < 3) findings.push({ level: "error", region: name, text: `${i ? "hole" : "outline"} has only ${ring.length} vertices` });
      else if (selfIntersects(ring)) findings.push({ level: "error", region: name, code: "self-intersects", text: `${i ? "hole" : "outline"} crosses itself` });
    });
    if (!counts[name]) findings.push({ level: "warn", region: name, text: "no spawns assigned" });
  }

  for (const s of spawns) {
    const legs = paths ? paths[s.id]?.legs : s.path;
    if (legs && legs.length < 2) {
      findings.push({ level: "error", spawnId: s.id, text: `${s.name} has a route with ${legs.length} legs` });
    }
    const named = assign[s.id] ?? [];
    if (legs && named.length) {
      findings.push({ level: "error", spawnId: s.id, text: `${s.name} has both a region and a route` });
    }
    if (!named.length) continue;

    const undefined_ = named.filter(n => !regions[n]);
    for (const name of undefined_) {
      findings.push({ level: "error", spawnId: s.id, region: name, text: `${s.name} points at undefined region ${name}` });
    }
    if (undefined_.length) continue;
    if (!s.at) continue; // placed by its region now, nothing to check against

    // With several, standing outside is only worth saying when it is outside all of them: the
    // server picks one at random, so being inside any one of them is the mob doing as it is told.
    const name = named.find(n => containsXZ(regions[n], s.x, s.z)) ?? named[0];
    const nearest = regionAt(regions, s.x, s.z, s.y);
    if (!named.some(n => containsXZ(regions[n], s.x, s.z))) {
      findings.push({ level: "info", spawnId: s.id, region: name, text: `${s.name} stands outside ${named.join(", ")}` });
    } else if (named.length === 1 && nearest && nearest !== name) {
      findings.push({ level: "warn", spawnId: s.id, region: name, text: `${s.name} is nearer ${nearest}'s floor` });
    }
  }

  const loose = spawns.filter(s => !assign[s.id]);
  // Informational, not a fault: a mob that stands in one place is placed correctly by a fixed point.
  if (loose.length) findings.push({ level: "info", text: `${loose.length} spawns on a fixed point` });

  // A region or a route replaces `at:`, so a spawn with none has nowhere to be placed. Counted, not
  // listed: zones ship with entries that never had a position, and one line per spawn buries the
  // findings that need acting on.
  const nowhere = loose.filter(s => !s.at && !s.path).length;
  if (nowhere) findings.push({ level: "warn", text: `${nowhere} spawns have no position, region or route` });
  return findings;
}

// Stable hue per region name, shared by the 3D overlay and the panel swatches.
export function regionHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return ((((hash & 0xffff) / 0xffff) * 0.87 + 0.18) % 1.0);
}
