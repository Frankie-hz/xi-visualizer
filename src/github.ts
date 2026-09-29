// Everything the editor writes goes to one branch on the contributor's own fork, holding one
// commit per zone, and a pull request from there into the staging repository.
//
// api.github.com sends CORS headers, so all of this runs from the browser with the user's token and
// needs no backend. Two steps are deliberately missing: forking the upstream repository and opening
// the pull request. A GitHub App cannot do either -- both require it to be installed on the account
// that owns the upstream repository, which is not ours to install on -- so those are links the user
// clicks on github.com, and everything in between is done here.

const API = "https://api.github.com";

/** Where pull requests go and zone data is read from, unless a link says otherwise. */
export const UPSTREAM = "LandSandBoat/server";
export const UPSTREAM_BASE = "base";
/** Where the zone folders live inside the repository. */
export const ZONES_DIR = "data/zones";

/** A file as committed, by ref or sha. Not rate limited, but cached by GitHub for a few minutes. */
export const rawUrl = (repo: string, ref: string, path: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

/**
 * A read of public data, sent with the signed-in token when there is one: that raises the hourly
 * limit from 60 to 5000, and 60 is a few page loads for a reviewer.
 *
 * A GitHub App's user token only reaches repositories the app is installed on, and GitHub answers
 * 404 rather than 403 for the rest; an expired one gets 401. Both read fine without the header, this
 * being public, so either is asked again without it rather than failing a read nobody had to sign
 * in for. The error carries `status`, so a 404 can be told apart from a failure.
 */
export async function ghPublic(path: string, token?: string): Promise<any> {
  const url = `${API}${path}`;
  const headers = { Accept: "application/vnd.github+json" };
  let res = await fetch(url, token ? { headers: { ...headers, Authorization: `Bearer ${token}` } } : { headers });
  if (token && (res.status === 404 || res.status === 401)) res = await fetch(url, { headers });
  if (res.ok) return res.json();
  const limited = (res.status === 403 || res.status === 429) && res.headers?.get?.("x-ratelimit-remaining") === "0";
  const error: any = new Error(
    limited
      ? token
        ? "GitHub's hourly request limit is used up; it resets within the hour"
        : "GitHub's hourly limit for signed-out requests is used up on this network. Signing in raises it from 60 to 5000"
      : res.status === 404
      ? `${path.split("?")[0]} was not found, or is private`
      : `${path.split("?")[0]} → HTTP ${res.status}`,
  );
  error.status = res.status;
  error.rateLimited = limited;
  throw error;
}

/** Every page of a listing that pages with per_page/page, up to `max` pages. */
export async function ghPublicPages(path: string, token?: string, max = 30): Promise<any[]> {
  const out: any[] = [];
  const joiner = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= max; page++) {
    const items = await ghPublic(`${path}${joiner}per_page=100&page=${page}`, token);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

async function gh(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  // A DELETE answers 204 with no body at all, which json() treats as malformed.
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);

  const where = `${init?.method ?? "GET"} ${path}`;
  // On a refusal GitHub names the permission the call wanted. "Resource not accessible by
  // integration" on its own is a puzzle; with the permission named it is an instruction, and the
  // usual cause is an installation still on the permissions it was created with.
  const needs = res.headers?.get?.("x-accepted-github-permissions");
  const error: any = new Error(
    res.status === 401
      ? "your GitHub session expired, sign in again"
      : res.status === 403 && needs
      ? `${where} → 403. The app installation does not grant ${needs}. Accept the app's pending `
        + `permission request at github.com/settings/installations, then save again.`
      : `${where} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
  );
  error.status = res.status;
  error.path = path;
  error.needs = needs;
  throw error;
}

/**
 * Whether a failed save was GitHub refusing to let the app create or move the branch because it
 * would bring workflow changes into the fork: a bare 403 on the ref, naming no permission. Syncing
 * the fork is the way out, the same one findFork offers when it sees this coming.
 */
export const refusedForWorkflows = (e: unknown) => {
  const err = e as { status?: number; path?: string; needs?: string | null; };
  return err.status === 403 && !err.needs && /\/git\/refs/.test(err.path ?? "");
};

/** Same, but a 404 is an answer rather than a failure. */
async function ghMaybe(token: string, path: string) {
  try {
    return await gh(token, path);
  } catch (e) {
    if ((e as { status?: number; }).status === 404) return null;
    throw e;
  }
}

export async function whoAmI(token: string): Promise<string> {
  return (await gh(token, "/user")).login;
}

export type ForkState =
  /** Ready to write to. */
  | { state: "ready"; repo: string; }
  /** No fork yet, so there is nothing to install onto either. */
  | { state: "missing"; }
  /** The fork is there and the app is authorized, but it was never installed on the repository. */
  | { state: "not_installed"; repo: string; }
  /** Installed, but granting less than writing needs -- an installation keeps the permissions it
   * was created with until the account owner accepts a newer set. */
  | { state: "needs_permission"; repo: string; granted: string; }
  /** Writable, but a branch cut from the staging tip would carry workflow changes into this fork,
   * which an app may not do without `workflows: write`. */
  | { state: "needs_sync"; repo: string; };

/** Where the app gets installed on a repository. Signing in does not do this and cannot. */
export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

/**
 * The installation covering `repo`, and what it was actually granted.
 *
 * Asked because reading proves nothing: a user access token may read any public repository whether
 * or not the app was ever installed on it, so a fork reads back perfectly and then refuses the
 * first write. What it grants matters just as much -- an installation keeps the permissions it was
 * created with until its owner accepts a newer set, so one made before the app asked for write
 * access is installed, looks right, and cannot commit.
 */
async function installationFor(
  token: string,
  repo: string,
): Promise<{ found: boolean; permissions?: Record<string, string>; }> {
  // Both lists page, and both can genuinely run long: somebody in a few organisations has several
  // installations, and one installed on "all repositories" lists every repository they own. Reading
  // only the first page reports "not installed" and sends them to a link that is already done.
  for (let page = 1;; page++) {
    const { installations } = await gh(token, `/user/installations?per_page=100&page=${page}`);
    if (!installations?.length) return { found: false };

    for (const installation of installations) {
      for (let inner = 1;; inner++) {
        const { repositories } = await gh(token, `/user/installations/${installation.id}/repositories?per_page=100&page=${inner}`);
        if (!repositories?.length) break;
        if (repositories.some((r: any) => r.full_name === repo)) {
          return { found: true, permissions: installation.permissions ?? {} };
        }
        if (repositories.length < 100) break;
      }
    }
    if (installations.length < 100) return { found: false };
  }
}

/**
 * Finds the user's fork of `upstream`, and whether it can actually be written to.
 *
 * Both halves matter and they fail differently: no fork at all means go and make one, while a fork
 * without an installation means go and install the app on it. Neither is something the app can do
 * on the user's behalf.
 */
/**
 * What the installation covering `repo` was granted, as a sentence, for putting in an error.
 *
 * A refusal that says only "Resource not accessible by integration" leaves two very different
 * causes indistinguishable: an installation that was never granted write, and one that has it and
 * is being refused for some other reason. Reporting what it holds separates them.
 */
export async function grantedOn(token: string, repo: string): Promise<string> {
  try {
    const found = await installationFor(token, repo);
    if (!found.found) return "the app is not installed on it at all";
    const granted = Object.entries(found.permissions ?? {}).map(([k, v]) => `${k}: ${v}`).sort().join(", ");
    return granted ? `its installation grants ${granted}` : "its installation grants nothing";
  } catch {
    return "its installation could not be read";
  }
}

export async function findFork(token: string, upstream: string, login: string, base?: string): Promise<ForkState> {
  // Membership is of the fork *network*, not of one parent. Contributors fork LandSandBoat/server
  // while pull requests target a fork of it, so an immediate-parent test would reject every
  // legitimate fork. Everything in one network shares an object store, which is also what lets a
  // branch be cut straight from a sibling fork further down.
  const target = await gh(token, `/repos/${upstream}`);
  const network = target.source?.full_name ?? target.full_name;

  const repo = `${login}/${upstream.split("/")[1]}`;
  const mine = await ghMaybe(token, `/repos/${repo}`);
  const sameNetwork = mine && (mine.source?.full_name ?? mine.full_name) === network;
  if (!sameNetwork) return { state: "missing" };

  // Asked before any drawing happens, because all three of these fail at the first commit and
  // "Resource not accessible by integration" an hour later is not something anyone can act on.
  const installation = await installationFor(token, repo);
  if (!installation.found) return { state: "not_installed", repo };
  // "Create a reference" takes Contents (write), or Contents (write) *and* Workflows (write) when
  // the ref carries workflow changes -- which a branch cut from staging does for any fork that has
  // fallen behind. Contents is the floor; Workflows decides which of the next two answers applies.
  if (installation.permissions?.contents !== "write") {
    return { state: "needs_permission", repo, granted: `contents: ${installation.permissions?.contents ?? "none"}` };
  }
  // Needs both: an installation may hold contents: write and still be refused the ref.
  const canTouchWorkflows = installation.permissions?.workflows === "write";
  if (base && !canTouchWorkflows && await wouldCarryWorkflows(token, repo, upstream, base)) {
    return { state: "needs_sync", repo };
  }
  return { state: "ready", repo };
}

/**
 * Whether cutting a branch from `baseRepo@base` would introduce workflow changes into `fork`.
 *
 * Creating that ref makes every commit between the fork and the staging tip reachable, and GitHub
 * refuses to let an app introduce commits that touch .github/workflows without `workflows: write`.
 * It is refused as a bare 403 on the ref, long after the trees and commits it also wrote succeeded,
 * so it is worth knowing before anybody draws anything. Comparing the two workflow directories is
 * exactly the question, and costs two reads.
 */
async function wouldCarryWorkflows(token: string, fork: string, baseRepo: string, base: string): Promise<boolean> {
  const treeOf = async (repo: string, ref: string) => (await ghMaybe(token, `/repos/${repo}/git/trees/${ref}:.github/workflows`))?.sha as string | undefined;
  const [mine, theirs] = await Promise.all([
    treeOf(fork, (await gh(token, `/repos/${fork}`)).default_branch),
    treeOf(baseRepo, base),
  ]);
  // Unreadable either side is not evidence of a problem; let the save speak for itself.
  return !!mine && !!theirs && mine !== theirs;
}

/** github.com's own fork page. One click, and it is the only way an app can get a fork made. */
export const forkUrl = (upstream: string) => `https://github.com/${upstream}/fork`;

/**
 * GitHub's pull request form, comparing the working branch against upstream. `quick_pull=1` is the
 * documented way to open it ready to submit, and `title` and `body` can be appended to prefill it.
 */
export const compareUrl = (upstream: string, base: string, repo: string, branch: string) =>
  `https://github.com/${upstream}/compare/${base}...${repo.replace("/", ":")}:${branch}?quick_pull=1`;

/**
 * The pull request's title. A sitting's branch can hold several zones, so it names them while there
 * are few enough to read in a list of pull requests, and counts them after that.
 */
export function prTitle(zones: string[]): string {
  const named = zones.length === 0 ? "several zones" : zones.length <= 3 ? zones.join(", ") : `${zones.length} zones`;
  return `Roam regions: ${named}`;
}

/**
 * Fills `{{name}}` placeholders. A name with nothing to put in it is left as it was rather than
 * blanked, so a typo in the template shows up in the pull request instead of quietly vanishing.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name) => vars[name] ?? whole);
}

export interface SaveRequest {
  token: string;
  /** The fork, owner/name. Commits land here. */
  repo: string;
  /** Where `base` lives: the repository pull requests are opened against. */
  baseRepo: string;
  /** The sitting's working branch. It carries one commit per zone touched, and is rebuilt on
   * every save so that stays true. */
  branch: string;
  /** Branch in `baseRepo` the working branch is cut from, and the one a pull request targets. */
  base: string;
  /** The zone being saved. Its commit is the one replaced on the branch. */
  zone: string;
  message: string;
  files: { path: string; content: string; }[];
}

/** A zone on the working branch: its name, and the summary its own commit carries. */
export interface ZoneOnBranch {
  zone: string;
  /** The commit message with the leading `<zone>: ` taken off, e.g. "3 regions, 42 spawns placed". */
  summary: string;
}

/** Commit titles are written `<zone>: <summary>`, which is the only place a summary survives for
 * zones committed in an earlier save. The body under it is the changeset, not the summary. */
const summaryOf = (message: string) => {
  const title = message.split("\n")[0];
  return title.slice(title.indexOf(":") + 1).trim();
};

export interface SaveResult {
  /** The commit, absent when the files already matched the branch. */
  sha?: string;
  unchanged: boolean;
  /** True the first time, when the branch was cut and the fork brought up to date first. */
  created: boolean;
  /** Whether the branch exists now. False when there was nothing to commit and no branch yet, which
   * is the one case where offering a pull request link would lead to an empty compare page. */
  onBranch: boolean;
  /** The zones the branch now carries, one commit each, in the order they appear on it. */
  zones: ZoneOnBranch[];
}

/** One zone's contribution to the branch: the files it changes, and why. */
interface ZoneWork {
  message: string;
  /** Either a blob already in the repository, or new content to be written. */
  entries: { path: string; sha?: string; content?: string; }[];
}

/**
 * Git's own hash for a file's contents, computed here so an unchanged zone can be recognised
 * without uploading anything. Rebuilding the branch is otherwise indistinguishable from changing
 * it: commit hashes take in the time they were made, so a replay always produces new ones.
 */
async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}${String.fromCharCode(0)}`);
  const buffer = new Uint8Array(header.length + body.length);
  buffer.set(header);
  buffer.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The zone a path under data/zones/<zone>/ belongs to, or null for anything else. */
function zoneOfPath(path: string): string | null {
  const parts = path.split("/");
  return parts[0] === "data" && parts[1] === "zones" && parts.length > 3 ? parts[2] : null;
}

/**
 * Puts this zone on the working branch, as exactly one commit.
 *
 * The branch is rebuilt from the staging tip on every save rather than appended to: each zone
 * already on it is replayed as a single commit, this zone's is replaced, and the ref is moved to
 * the result. That is what keeps "one commit per zone" true no matter how many times a zone is
 * saved, and it means a branch whose work has since been merged quietly starts over rather than
 * carrying the merged commits around.
 */
/** The zones a set of commits covers, from the `<zone>: <summary>` messages they carry. */
const zonesInCommits = (commits: any[]): ZoneOnBranch[] => {
  const seen = new Map<string, string>();
  for (const entry of commits ?? []) {
    const message = String(entry.commit?.message ?? "");
    const zone = message.split(":")[0].trim();
    if (zone) seen.set(zone, summaryOf(message));
  }
  return [...seen.keys()].sort().map(zone => ({ zone, summary: seen.get(zone)! }));
};

export interface Sitting {
  /** The branch to read from and write to. */
  branch: string;
  /** Absent when the branch does not exist yet, i.e. nothing has been committed this sitting. */
  ancestor?: string;
  /** What the branch already carries, so a pull request can be opened without saving again. */
  zones: ZoneOnBranch[];
}

/**
 * The sitting in progress.
 *
 * Work sits on the contributor's own branch until their pull request is merged, so the staging
 * branch is not where their most recent zone lives -- reading from it after a commit shows the zone
 * as it was before, which reads as the work having been lost. A sitting therefore continues for as
 * long as its branch is still ahead of staging, whatever day it was started on, and only once it
 * has been merged does the next save begin a new one.
 */
export async function findSitting(
  token: string,
  fork: string,
  baseRepo: string,
  base: string,
  today: string,
): Promise<Sitting> {
  const baseSha = (await gh(token, `/repos/${baseRepo}/git/ref/heads/${base}`)).object.sha as string;
  const refs = (await ghMaybe(token, `/repos/${fork}/git/matching-refs/heads/regions/`)) ?? [];
  // Newest first, which the date in the name gives for free.
  const names = refs.map((r: any) => String(r.ref).replace("refs/heads/", "")).sort().reverse();

  for (const branch of names) {
    const diff = await ghMaybe(token, `/repos/${fork}/compare/${baseSha}...${branch}`);
    if (!diff || diff.ahead_by === 0) continue; // merged, or never had anything
    return { branch, ancestor: diff.merge_base_commit?.sha, zones: zonesInCommits(diff.commits) };
  }
  return { branch: today, zones: [] };
}

/** Every regions/* branch on the fork, newest name first, which the date in the name gives. */
export async function listRegionBranches(token: string, fork: string): Promise<string[]> {
  const refs = (await ghMaybe(token, `/repos/${fork}/git/matching-refs/heads/regions/`)) ?? [];
  return refs.map((r: any) => String(r.ref).replace("refs/heads/", "")).sort().reverse();
}

/**
 * A branch name nothing on the fork is using yet. Reusing one would point an existing ref at the
 * base and rebuild it, which is a reset of somebody's open pull request rather than a new branch.
 */
export function freeBranchName(taken: string[], wanted: string): string {
  if (!taken.includes(wanted)) return wanted;
  for (let n = 2;; n++) {
    const name = `${wanted}-${n}`;
    if (!taken.includes(name)) return name;
  }
}

/**
 * Throws the sitting away. Its commits become unreachable and this cannot be undone from here, so
 * it is worth asking before calling. An open pull request for the branch is left with nothing to
 * merge, which GitHub shows as closed.
 */
export async function deleteBranch(token: string, repo: string, branch: string): Promise<void> {
  await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
}

/** The zones among `work` with a file whose content on `baseRepo` differs between two commits. */
async function changedOnBase(token: string, baseRepo: string, from: string, to: string, work: [string, ZoneWork][]): Promise<string[]> {
  const blobs = async (sha: string, zone: string) =>
    new Map<string, string>(((await ghMaybe(token, `/repos/${baseRepo}/git/trees/${sha}:data/zones/${zone}`))?.tree ?? []).map((e: any) => [e.path, e.sha]));
  const stale = await Promise.all(work.map(async ([zone, { entries }]) => {
    const [before, now] = await Promise.all([blobs(from, zone), blobs(to, zone)]);
    return entries.some(e => before.get(e.path.split("/").pop()!) !== now.get(e.path.split("/").pop()!)) ? zone : null;
  }));
  return stale.filter((z): z is string => !!z).sort();
}

const listing = (work: Map<string, ZoneWork>): ZoneOnBranch[] => [...work.keys()].sort().map(zone => ({ zone, summary: summaryOf(work.get(zone)!.message) }));

export async function save(req: SaveRequest): Promise<SaveResult> {
  const { token, repo, baseRepo, branch, base, zone, files } = req;

  // Forks in a network share objects, so this fork can point a ref straight at the staging tip
  // without being synced first -- and a branch cut this way is never behind.
  const baseSha = (await gh(token, `/repos/${baseRepo}/git/ref/heads/${base}`)).object.sha as string;
  const head = (await ghMaybe(token, `/repos/${repo}/git/ref/heads/${branch}`))?.object?.sha as string | undefined;

  // What the branch already carries, per zone. Comparing against the *current* staging tip is what
  // makes merged work disappear from this set on its own.
  const work = new Map<string, ZoneWork>();
  let cutFrom: string | undefined;
  if (head && head !== baseSha) {
    const diff = await gh(token, `/repos/${repo}/compare/${baseSha}...${head}`);
    cutFrom = diff.merge_base_commit?.sha;
    const messages = new Map<string, string>();
    for (const entry of diff.commits ?? []) {
      const message = String(entry.commit?.message ?? "");
      const named = message.split(":")[0].trim();
      if (named) messages.set(named, message);
    }
    for (const file of diff.files ?? []) {
      const name = zoneOfPath(file.filename);
      if (!name || file.status === "removed") continue;
      const found = work.get(name) ?? { message: messages.get(name) ?? `${name}: regions`, entries: [] };
      found.entries.push({ path: file.filename, sha: file.sha });
      work.set(name, found);
    }
  }

  // Saving a zone that already matches what is on the branch must not rewrite anything.
  const already = work.get(zone);
  if (already) {
    const wanted = await Promise.all(files.map(async f => `${f.path}@${await blobSha(f.content)}`));
    const have = already.entries.map(e => `${e.path}@${e.sha}`);
    if (wanted.sort().join() === have.sort().join()) return { unchanged: true, created: false, onBranch: true, zones: listing(work) };
  }

  work.set(zone, { message: req.message, entries: files.map(f => ({ path: f.path, content: f.content })) });

  // Every other zone is replayed by blob, which replaces its files whole. One that base changed
  // since the branch was cut would be quietly reverted by that, so the save stops and says which.
  // The zone being saved has already been merged against base by the editor.
  if (cutFrom && cutFrom !== baseSha) {
    const stale = await changedOnBase(token, baseRepo, cutFrom, baseSha, [...work].filter(([name]) => name !== zone));
    if (stale.length) {
      const error: any = new Error(
        `${stale.join(", ")} changed on ${base} after ${stale.length === 1 ? "it was" : "they were"} saved to this branch, and saving `
          + `now would undo that. Open ${stale.length === 1 ? "it" : "each"} and save again, which merges the change in, then save this zone.`,
      );
      error.status = "stale";
      error.zones = stale;
      throw error;
    }
  }

  // Replay: one commit per zone, in a stable order so the branch reads the same way every time.
  let parent = baseSha;
  for (const name of [...work.keys()].sort()) {
    const { message, entries } = work.get(name)!;
    const parentCommit = await gh(token, `/repos/${repo}/git/commits/${parent}`);
    const tree = await gh(token, `/repos/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: entries.map(e => ({
          path: e.path,
          mode: "100644",
          type: "blob",
          ...(e.sha ? { sha: e.sha } : { content: e.content }),
        })),
      }),
    });
    if (tree.sha === parentCommit.tree.sha) continue; // this zone matches the staging branch already
    parent = (await gh(token, `/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
    })).sha;
  }

  if (parent === baseSha) return { unchanged: true, created: false, onBranch: !!head, zones: [] };

  if (head) {
    // Force, because replaying rewrote what was there. It is a working branch and this is its point.
    await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: parent, force: true }),
    });
  } else {
    await gh(token, `/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: parent }),
    });
  }

  return { sha: parent, unchanged: false, created: !head, onBranch: true, zones: listing(work) };
}
