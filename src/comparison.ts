// A pull request or a pair of branches, pinned to commits, for reviewing what it does to the spawn
// regions: which zones it touches, and either side of one of them.
import { ghPublic, ghPublicPages, rawUrl, ZONES_DIR } from "./github.ts";
import { parseMobsYaml, parseRegionsYaml } from "./regions.ts";
import type { RegionsDiff, ZoneSide } from "./regions.ts";

export interface ZoneChange {
  zone: string;
  additions: number;
  deletions: number;
  files: number;
}

/**
 * What is being compared, pinned to commits. Reading branch tips instead let a push mid-review, a
 * deleted branch or GitHub's few-minute raw cache change what was shown, and diffing against the
 * base tip showed everything merged since the branch was cut as this change, reversed.
 */
export interface Comparison {
  baseRepo: string;
  /** Where the head branch left base: the other side of what the change actually did. */
  baseSha: string;
  /** Where the head side is read from. For a pull request that is the base repository, which holds
   * its commits whether or not the fork or the branch still exists. */
  headRepo: string;
  headSha: string;
  /** Short names for the page, e.g. the branch or "#1234". */
  baseName: string;
  headName: string;
  /** The zones it touches, biggest change first. */
  zones: ZoneChange[];
  /** The listing stopped short, so there may be zones changed that are not in it. */
  partial: boolean;
  pr?: { number: number; title: string; url: string; state: string; merged: boolean; };
}

/** What to compare: a pull request, or a branch on one repository against one on another. */
export type CompareRequest = { repo: string; number: number; } | { baseRepo: string; base: string; headRepo: string; head: string; };

export const zonesTouched = (files: { filename: string; additions?: number; deletions?: number; }[]): ZoneChange[] => {
  const perZone = new Map<string, ZoneChange>();
  for (const file of files) {
    const parts = file.filename.split("/");
    if (`${parts[0]}/${parts[1]}` !== ZONES_DIR || parts.length < 4) continue;
    const seen = perZone.get(parts[2]) ?? { zone: parts[2], additions: 0, deletions: 0, files: 0 };
    seen.additions += file.additions ?? 0;
    seen.deletions += file.deletions ?? 0;
    seen.files += 1;
    perZone.set(parts[2], seen);
  }
  return [...perZone.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
};

export async function resolveComparison(what: CompareRequest, token?: string): Promise<Comparison> {
  if ("number" in what) {
    const pull = await ghPublic(`/repos/${what.repo}/pulls/${what.number}`, token);
    const baseRepo = pull.base.repo.full_name as string;
    // From the base commit the pull request was last compared against, not the branch tip: a
    // merged pull request's base has moved past it, and so has an open one's, often.
    const cmp = await ghPublic(`/repos/${baseRepo}/compare/${pull.base.sha}...${pull.head.sha}`, token);
    // Up to 3000 files, where compare stops at 300.
    const files = await ghPublicPages(`/repos/${baseRepo}/pulls/${what.number}/files`, token);
    return {
      baseRepo,
      baseSha: cmp.merge_base_commit?.sha ?? pull.base.sha,
      headRepo: baseRepo,
      headSha: pull.head.sha,
      baseName: pull.base.ref,
      headName: `#${what.number}`,
      zones: zonesTouched(files),
      partial: files.length >= 3000,
      pr: { number: what.number, title: pull.title, url: pull.html_url, state: pull.state, merged: !!pull.merged_at },
    };
  }
  // Across forks the head is named owner:repo:branch; within one repository it is just a ref.
  const [owner, name] = what.headRepo.split("/");
  const spec = what.headRepo === what.baseRepo ? what.head : `${owner}:${name}:${what.head}`;
  const cmp = await ghPublic(`/repos/${what.baseRepo}/compare/${encodeURIComponent(what.base)}...${encodeURIComponent(spec)}`, token).catch(e => {
    throw e.status === 404 ? new Error(`could not compare ${what.base} with ${what.headRepo}:${what.head}; is the branch still there?`) : e;
  });
  const mergeBase = cmp.merge_base_commit?.sha as string;
  return {
    baseRepo: what.baseRepo,
    baseSha: mergeBase,
    headRepo: what.headRepo,
    // Nothing ahead means the head is an ancestor of base, and so is where they meet.
    headSha: cmp.commits?.at(-1)?.sha ?? mergeBase,
    baseName: what.base,
    headName: what.head,
    zones: zonesTouched(cmp.files ?? []),
    partial: (cmp.files?.length ?? 0) >= 300,
  };
}

/**
 * One side of a zone, read at a commit. A 404 is the zone not existing there, which on the base side
 * is a zone the change adds; anything else is a failed read, and treating that as an empty zone
 * showed every region as added with no error at all.
 */
export async function readSide(repo: string, sha: string, zone: string): Promise<ZoneSide> {
  const get = async (file: string) => {
    const res = await fetch(rawUrl(repo, sha, `${ZONES_DIR}/${zone}/${file}`));
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    throw new Error(`${file} at ${repo}@${sha.slice(0, 7)} → HTTP ${res.status}`);
  };
  const [regionsYaml, mobsYaml] = await Promise.all([get("regions.yaml"), get("mobs.yaml")]);
  if (!mobsYaml) return { regions: {}, spawns: [] };
  return { regions: regionsYaml ? parseRegionsYaml(regionsYaml) : {}, spawns: parseMobsYaml(mobsYaml) };
}

/** How much a comparison changes in one zone, for the list. */
export const changeCount = (d: RegionsDiff) =>
  d.added.length + d.removed.length + d.reshaped.length + d.moved.length + d.rerouted.length + d.relocated.length + d.addedSpawns.length
  + d.removedSpawns.length;
