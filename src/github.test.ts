// node src/github.test.ts  (run by `pnpm test`)
//
// The write path has branches that only show themselves against a real repository: the first save
// cuts a branch, later ones move it, and an unchanged tree must not become an empty commit. A fake
// GitHub is enough to hold all three honest.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  compareUrl,
  deleteBranch,
  fillTemplate,
  findFork,
  findSitting,
  freeBranchName,
  ghPublic,
  ghPublicPages,
  parsePr,
  prTitle,
  refusedForWorkflows,
  save,
  whoAmI,
} from "./github.ts";

const noHeaders = { get: () => null };

interface Call {
  method: string;
  path: string;
  body?: any;
}

/** Answers by method and path; anything unlisted is a 404, which is a real answer here. */
function fakeGitHub(routes: Record<string, any>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    // An entry may be keyed with or without the method, and may be a function of the request.
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const value = typeof hit === "function" ? hit(calls) : hit;
    if (value === undefined) return { ok: false, status: 404, headers: noHeaders, text: async () => "no such thing" };
    if (value?.$noBody) {
      return {
        ok: true,
        status: 204,
        headers: noHeaders,
        json: async () => {
          throw new Error("no body");
        },
      };
    }
    if (value?.$status) {
      return { ok: false, status: value.$status, headers: value.$headers ?? noHeaders, text: async () => value.$body ?? "" };
    }
    return { ok: true, status: 200, headers: noHeaders, json: async () => value, text: async () => JSON.stringify(value) };
  };
  return calls;
}

const UPSTREAM = "sruon/server";
const FORK = "someone/server";

// --- public reads ---

// A user token the app is not installed for reads as 404; the same read without it succeeds.
let publicCalls: string[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  publicCalls.push(init?.headers?.Authorization ? "token" : "anon");
  return init?.headers?.Authorization
    ? { ok: false, status: 404, headers: noHeaders }
    : { ok: true, status: 200, headers: noHeaders, json: async () => ({ fine: true }) };
};
assert.deepStrictEqual(await ghPublic("/repos/a/b", "t"), { fine: true });
assert.deepStrictEqual(publicCalls, ["token", "anon"], "asked again without the token");

// The rate limit says what it is and what raises it.
(globalThis as any).fetch = async () => ({ ok: false, status: 403, headers: { get: (h: string) => (h === "x-ratelimit-remaining" ? "0" : null) } });
await assert.rejects(ghPublic("/repos/a/b"), (e: any) => e.rateLimited && /Signing in raises it/.test(e.message));

// Pages until a short one.
publicCalls = [];
(globalThis as any).fetch = async (url: string) => {
  publicCalls.push(url);
  const page = Number(new URL(url).searchParams.get("page"));
  return { ok: true, status: 200, headers: noHeaders, json: async () => Array.from({ length: page === 1 ? 100 : 7 }, (_, i) => i) };
};
assert.strictEqual((await ghPublicPages("/repos/a/b/pulls/1/files")).length, 107);
assert.strictEqual(publicCalls.length, 2, "stopped at the short page");

// A pull request can arrive as a link, the /files or /changes view of one, or a number.
assert.deepStrictEqual(parsePr("https://github.com/LandSandBoat/server/pull/11610/changes"), { repo: "LandSandBoat/server", number: 11610 });
assert.deepStrictEqual(parsePr(" #11610 "), { repo: "LandSandBoat/server", number: 11610 });
assert.deepStrictEqual(parsePr("11610", "sruon/server"), { repo: "sruon/server", number: 11610 });
assert.deepStrictEqual(parsePr("someone/server#7"), { repo: "someone/server", number: 7 });
assert.strictEqual(parsePr("regions/2026-09-01"), undefined, "a branch name is not a pull request");

// --- finding the fork ---

// The staging repo is itself a fork, so every check is against the network root rather than a parent.
const NETWORK = "LandSandBoat/server";
const upstreamIs = { "/repos/sruon/server": { full_name: UPSTREAM, source: { full_name: NETWORK } } };
const forkExists = { ...upstreamIs, "/repos/someone/server": { fork: true, source: { full_name: NETWORK } } };
const installedFor = (full_name: string, permissions: Record<string, string> = { contents: "write" }) => ({
  "/user/installations?per_page=100&page=1": { installations: [{ id: 7, permissions }] },
  "/user/installations/7/repositories?per_page=100&page=1": { repositories: [{ full_name }] },
});
const installedHere = installedFor(FORK);

fakeGitHub({ ...forkExists, ...installedHere });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: FORK });

// A repo of the same name that is not a fork of ours is not ours to write to.
fakeGitHub({ ...upstreamIs, "/repos/someone/server": { fork: true, source: { full_name: "someone-else/thing" } } });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "missing" }, "a repo outside the network is not ours to write to");

// A fork under another name, as GitHub makes when "server" was already taken, is still theirs.
fakeGitHub({
  ...upstreamIs,
  "/repos/someone/server": { fork: false, full_name: "someone/server" },
  "/user/repos?affiliation=owner&per_page=100&page=1": [{ full_name: "someone/server", fork: false }, { full_name: "someone/server-1", fork: true }],
  "/repos/someone/server-1": { fork: true, full_name: "someone/server-1", source: { full_name: NETWORK } },
  ...installedFor("someone/server-1"),
});
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: "someone/server-1" }, "found under its other name");

// The maintainer's own fork is the staging repo itself, and has to be accepted like any other.
fakeGitHub({ ...upstreamIs, "/repos/sruon/server": { full_name: UPSTREAM, source: { full_name: NETWORK } }, ...installedFor("sruon/server") });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "sruon"), { state: "ready", repo: "sruon/server" });

// Authorised but never installed. The token reads the public fork without trouble, so reading is
// not the question: this is the case that used to report "ready" and then 403 on the first write.
fakeGitHub({ ...forkExists, "/user/installations?per_page=100&page=1": { installations: [] } });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "not_installed", repo: FORK });

// Installed, but on some other repository of theirs.
fakeGitHub({
  ...forkExists,
  "/user/installations?per_page=100&page=1": { installations: [{ id: 7, permissions: { contents: "write" } }] },
  "/user/installations/7/repositories?per_page=100&page=1": { repositories: [{ full_name: "someone/notes" }] },
});
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "not_installed", repo: FORK });

// --- which sitting is in progress ---

const TODAY = "regions/2026-08-24";
const sittingRoutes = {
  "/repos/sruon/server/git/ref/heads/regions-master": { object: { sha: "base-sha" } },
};

// Nothing started yet: today's name, and nothing to open a pull request for.
fakeGitHub({ ...sittingRoutes, "/repos/someone/server/git/matching-refs/heads/regions/": [] });
assert.deepStrictEqual(await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY), { branch: TODAY, zones: [] });

// A branch still ahead of staging is the sitting, whatever day it was started on: its pull request
// has not been merged, so its work is not on staging and the editor has to keep reading from it.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: "refs/heads/regions/2026-08-23" }],
  "/repos/someone/server/compare/base-sha...regions/2026-08-23": {
    ahead_by: 2,
    merge_base_commit: { sha: "cut-from" },
    commits: [
      { commit: { message: "west_ronfaure: 1 region, 1 spawn placed\n\nAdded: nw_1\nPlaced in nw_1: Orc 1" } },
      { commit: { message: "toraimarai_canal: 1 region, 0 spawns placed" } },
    ],
  },
});
assert.deepStrictEqual(await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY), {
  branch: "regions/2026-08-23",
  ancestor: "cut-from",
  zones: [
    { zone: "toraimarai_canal", summary: "1 region, 0 spawns placed" },
    { zone: "west_ronfaure", summary: "1 region, 1 spawn placed" },
  ],
}, "yesterday's unmerged branch continues, carrying what it already holds, the summary being the title alone");

// Once it is merged it is no longer ahead, so the next save starts a new sitting.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: "refs/heads/regions/2026-08-23" }],
  "/repos/someone/server/compare/base-sha...regions/2026-08-23": { ahead_by: 0, commits: [] },
});
assert.deepStrictEqual(await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY), { branch: TODAY, zones: [] });

// Squash-merged: still ahead, but its pull request is done, so a new sitting starts, on a name of its own.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: `refs/heads/${TODAY}` }],
  [`/repos/someone/server/compare/base-sha...${TODAY}`]: { ahead_by: 1, merge_base_commit: { sha: "cut-from" }, commits: [] },
  [`/repos/sruon/server/pulls?head=someone:${encodeURIComponent(TODAY)}&state=all&per_page=10`]: [{ state: "closed", merged_at: "2026-09-01T00:00:00Z" }],
});
assert.deepStrictEqual(await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY), { branch: `${TODAY}-2`, zones: [] }, "a merged pull request ends it");

// The newest commit comes along, so the zone can be read at it rather than through a cache.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: `refs/heads/${TODAY}` }],
  [`/repos/someone/server/compare/base-sha...${TODAY}`]: {
    ahead_by: 1,
    merge_base_commit: { sha: "cut-from" },
    commits: [{ sha: "c1", commit: { message: "a: x" } }, { sha: "c2", commit: { message: "b: y" } }],
  },
});
assert.strictEqual((await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY)).head, "c2");

// Its pull request still open: saves go on adding to it, and the page can say which one.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: `refs/heads/${TODAY}` }],
  [`/repos/someone/server/compare/base-sha...${TODAY}`]: { ahead_by: 1, merge_base_commit: { sha: "cut-from" }, commits: [] },
  [`/repos/sruon/server/pulls?head=someone:${encodeURIComponent(TODAY)}&state=all&per_page=10`]: [{ state: "open", number: 42, html_url: "https://x/42" }],
});
assert.deepStrictEqual((await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY)).pr, { number: 42, url: "https://x/42" });

// Several old branches: the newest one still ahead wins.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [
    { ref: "refs/heads/regions/2026-08-20" },
    { ref: "refs/heads/regions/2026-08-23" },
  ],
  "/repos/someone/server/compare/base-sha...regions/2026-08-23": {
    ahead_by: 1,
    merge_base_commit: { sha: "cut-from" },
    commits: [{ commit: { message: "west_ronfaure: 1 region, 1 spawn placed" } }],
  },
});
assert.strictEqual((await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY)).branch, "regions/2026-08-23");

// A branch named by hand is newer than a dated one when its last commit is.
fakeGitHub({
  ...sittingRoutes,
  "/repos/someone/server/git/matching-refs/heads/regions/": [{ ref: "refs/heads/regions/2026-08-23" }, { ref: "refs/heads/regions/barges" }],
  "/repos/someone/server/compare/base-sha...regions/2026-08-23": {
    ahead_by: 1,
    commits: [{ sha: "old", commit: { message: "a: x", committer: { date: "2026-08-23T10:00:00Z" } } }],
  },
  "/repos/someone/server/compare/base-sha...regions/barges": {
    ahead_by: 1,
    commits: [{ sha: "new", commit: { message: "b: y", committer: { date: "2026-08-20T10:00:00Z" } } }],
  },
});
assert.strictEqual((await findSitting("t", FORK, UPSTREAM, "regions-master", TODAY)).branch, "regions/2026-08-23", "the later commit wins");

// A new branch must not land on a name already in use: pointing an existing ref at the base and
// rebuilding it is a reset of whatever pull request was open for it, not a new branch.
assert.strictEqual(freeBranchName([], "regions/2026-09-01"), "regions/2026-09-01");
assert.strictEqual(freeBranchName(["regions/2026-09-01"], "regions/2026-09-01"), "regions/2026-09-01-2");
assert.strictEqual(
  freeBranchName(["regions/2026-09-01", "regions/2026-09-01-2"], "regions/2026-09-01"),
  "regions/2026-09-01-3",
);

// --- saving ---

const ZONE = "west_ronfaure";
const SITTING = "regions/2026-08-23";
const files = [{ path: `data/zones/${ZONE}/regions.yaml`, content: "regions:\n" }];
const saving = { token: "t", repo: FORK, baseRepo: UPSTREAM, branch: SITTING, base: "regions-master" };
const thisZone = { zone: ZONE, message: `${ZONE}: 3 regions, 42 spawns placed`, files };

// The staging tip is read on every save, so it belongs to every case.
const nth = (calls, suffix) => calls.filter(c => c.method === "POST" && c.path.endsWith(suffix)).length;
const commonRoutes = {
  "/repos/sruon/server/git/ref/heads/regions-master": { object: { sha: "base-sha" } },
  "/repos/someone/server/git/commits/base-sha": { tree: { sha: "tree-old" } },
  "/repos/someone/server/git/commits/commit-1": { tree: { sha: "tree-1" } },
  "/repos/someone/server/git/commits/commit-2": { tree: { sha: "tree-2" } },
  // Each replayed zone builds on the one before, so a fake that answered with one sha forever
  // would make every commit after the first look like a no-op.
  "POST /repos/someone/server/git/trees": calls => ({ sha: `tree-${nth(calls, "/git/trees")}` }),
  "POST /repos/someone/server/git/commits": calls => ({ sha: `commit-${nth(calls, "/git/commits")}` }),
  "POST /repos/someone/server/git/refs": {},
};
const branchAt = sha => ({ [`/repos/someone/server/git/ref/heads/${SITTING}`]: { object: { sha } } });

// first save of a sitting: the branch is cut straight from the staging tip
let calls = fakeGitHub({ ...commonRoutes });
let result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, {
  sha: "commit-1",
  unchanged: false,
  created: true,
  onBranch: true,
  zones: [{ zone: ZONE, summary: "3 regions, 42 spawns placed" }],
});
assert.ok(
  calls.some(c => c.path === "/repos/sruon/server/git/ref/heads/regions-master"),
  "cut from the staging branch itself, which forks in a network can point a ref at",
);
assert.ok(!calls.some(c => c.path.endsWith("/merge-upstream")), "so there is nothing to sync");
assert.ok(calls.some(c => c.method === "POST" && c.path.endsWith("/git/refs")), "created the branch");

// A second zone in the same sitting: the first one is replayed from its existing blob, so the
// branch ends up carrying one commit each rather than a commit per save.
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  [`PATCH /repos/someone/server/git/refs/heads/${SITTING}`]: {},
  "/repos/someone/server/compare/base-sha...branch-sha": {
    commits: [{ commit: { message: "east_ronfaure: 1 region, 8 spawns placed" } }],
    files: [{ filename: "data/zones/east_ronfaure/regions.yaml", sha: "blob-east", status: "modified" }],
  },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(
  result.zones,
  [
    { zone: "east_ronfaure", summary: "1 region, 8 spawns placed" },
    { zone: ZONE, summary: "3 regions, 42 spawns placed" },
  ],
  "each zone comes back with the summary its own commit carries, so a pull request can list them all",
);
const commits = calls.filter(c => c.method === "POST" && c.path.endsWith("/git/commits"));
assert.strictEqual(commits.length, 2, "one commit per zone, not one per save");
assert.deepStrictEqual(
  commits.map(c => c.body.message),
  ["east_ronfaure: 1 region, 8 spawns placed", `${ZONE}: 3 regions, 42 spawns placed`],
  "each zone keeps its own message, in a stable order",
);
const trees = calls.filter(c => c.method === "POST" && c.path.endsWith("/git/trees"));
assert.strictEqual(trees[0].body.tree[0].sha, "blob-east", "the untouched zone is replayed by blob, not re-uploaded");
assert.strictEqual(trees[1].body.tree[0].content, "regions:\n", "and the saved zone by its new content");
assert.ok(calls.some(c => c.method === "PATCH" && c.body.force === true), "the rewrite has to be forced");

// Re-saving a zone whose content already matches must not rewrite the branch at all: replaying
// would mint new commit hashes every time, since a commit takes in when it was made.
// git's real hash for the fixture, so the short-circuit is exercised rather than assumed
const sameBlob = "32cb00a14923d6708072e2291c6d1afce217022c";
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  "/repos/someone/server/compare/base-sha...branch-sha": {
    commits: [{ commit: { message: `${ZONE}: 3 regions, 42 spawns placed` } }],
    files: [{ filename: `data/zones/${ZONE}/regions.yaml`, sha: sameBlob, status: "modified" }],
  },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: true, zones: [{ zone: ZONE, summary: "3 regions, 42 spawns placed" }] });
assert.ok(!calls.some(c => c.method === "PATCH" || c.path.endsWith("/git/commits") && c.method === "POST"), "nothing was rewritten");

// Work already merged into the staging branch compares away, so the sitting starts over instead of
// dragging the merged commits along behind it.
calls = fakeGitHub({
  ...commonRoutes,
  ...branchAt("branch-sha"),
  [`PATCH /repos/someone/server/git/refs/heads/${SITTING}`]: {},
  "/repos/someone/server/compare/base-sha...branch-sha": { commits: [], files: [] },
});
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result.zones, [{ zone: ZONE, summary: "3 regions, 42 spawns placed" }], "only the zone being saved is left");

// A zone already on the branch that base has changed since: replaying its old blob would revert
// that change, so the save refuses and names the zone rather than committing.
const eastOnBranch = {
  ...commonRoutes,
  ...branchAt("branch-sha"),
  [`PATCH /repos/someone/server/git/refs/heads/${SITTING}`]: {},
  "/repos/someone/server/compare/base-sha...branch-sha": {
    merge_base_commit: { sha: "cut-sha" },
    commits: [{ commit: { message: "east_ronfaure: 1 region, 8 spawns placed" } }],
    files: [{ filename: "data/zones/east_ronfaure/mobs.yaml", sha: "blob-east", status: "modified" }],
  },
  "/repos/sruon/server/git/trees/cut-sha:data/zones/east_ronfaure": { tree: [{ path: "mobs.yaml", sha: "mobs-then" }] },
};
calls = fakeGitHub({ ...eastOnBranch, "/repos/sruon/server/git/trees/base-sha:data/zones/east_ronfaure": { tree: [{ path: "mobs.yaml", sha: "mobs-now" }] } });
await assert.rejects(save({ ...saving, ...thisZone }), (e: any) => e.status === "stale" && e.zones.join() === "east_ronfaure", "names the zone base changed");
assert.ok(!calls.some(c => c.method === "POST" || c.method === "PATCH"), "and writes nothing");

// the same, with base untouched there: the replay is safe and goes ahead
calls = fakeGitHub({ ...eastOnBranch, "/repos/sruon/server/git/trees/base-sha:data/zones/east_ronfaure": { tree: [{ path: "mobs.yaml", sha: "mobs-then" }] } });
result = await save({ ...saving, ...thisZone });
assert.strictEqual(result.unchanged, false, "an untouched zone replays as before");

// nothing to commit and no branch either: no pull request to offer, which is what onBranch says
calls = fakeGitHub({ ...commonRoutes, "POST /repos/someone/server/git/trees": { sha: "tree-old" } });
result = await save({ ...saving, ...thisZone });
assert.deepStrictEqual(result, { unchanged: true, created: false, onBranch: false, zones: [] });

// A refusal has to arrive naming the permission and the way out, since "Resource not accessible by
// integration" is what GitHub says when an installation is still on the permissions it was made with.
fakeGitHub({
  ...commonRoutes,
  "POST /repos/someone/server/git/trees": {
    $status: 403,
    $headers: { get: h => (h === "x-accepted-github-permissions" ? "contents=write" : null) },
    $body: '{"message":"Resource not accessible by integration"}',
  },
});
await assert.rejects(
  save({ ...saving, ...thisZone }),
  /does not grant contents=write/s,
  "the error names the permission and where to grant it",
);

// The ref refused with no permission named is the workflow case, and the page turns it into the
// "sync your fork" panel rather than showing the raw refusal.
fakeGitHub({
  ...commonRoutes,
  "POST /repos/someone/server/git/refs": { $status: 403, $body: '{"message":"Resource not accessible by integration"}' },
});
await assert.rejects(save({ ...saving, ...thisZone }), (e: unknown) => refusedForWorkflows(e), "a bare 403 on the ref is the workflow case");

// An installation spread over more pages than one: reading only the first reported "not installed"
// and sent people to a link that was already done.
fakeGitHub({
  ...upstreamIs,
  "/repos/someone/server": { fork: true, source: { full_name: NETWORK } },
  "/user/installations?per_page=100&page=1": { installations: [{ id: 7, permissions: { contents: "write" } }] },
  "/user/installations/7/repositories?per_page=100&page=1": {
    repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `someone/filler-${i}` })),
  },
  "/user/installations/7/repositories?per_page=100&page=2": { repositories: [{ full_name: FORK }] },
});
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: FORK }, "found on the second page");

// Installed, but on an older permission set. This is what "Resource not accessible by integration"
// means at the first commit, and it is worth catching before an hour of drawing rather than after:
// an installation keeps what it was created with until its owner accepts a newer set.
fakeGitHub({ ...forkExists, ...installedFor(FORK, { contents: "read", metadata: "read" }) });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), {
  state: "needs_permission",
  repo: FORK,
  granted: "contents: read",
});

// An installation granting nothing at all reads the same way rather than throwing.
fakeGitHub({ ...forkExists, ...installedFor(FORK, {}) });
assert.strictEqual((await findFork("t", UPSTREAM, "someone")).state, "needs_permission");

// Writable, but the fork has fallen far enough behind that the first branch would carry workflow
// changes into it. "Create a reference" takes Contents (write) alone only when it does not; with
// workflow files in the way it wants Workflows (write) too, and refuses with a bare 403 on the ref
// after the trees and commits it also wrote have already succeeded.
const workflowTrees = (fork: string, staging: string) => ({
  "/repos/someone/server": { full_name: FORK, source: { full_name: NETWORK }, fork: true, default_branch: "base" },
  "/repos/someone/server/git/trees/base:.github/workflows": { sha: fork },
  "/repos/sruon/server/git/trees/regions-master:.github/workflows": { sha: staging },
});

fakeGitHub({ ...forkExists, ...installedFor(FORK), ...workflowTrees("stale-tree", "current-tree") });
assert.deepStrictEqual(
  await findFork("t", UPSTREAM, "someone", "regions-master"),
  { state: "needs_sync", repo: FORK },
  "a fork whose workflows differ cannot be branched into without the extra permission",
);

// The same fork, once synced, is ready -- no new permission needed.
fakeGitHub({ ...forkExists, ...installedFor(FORK), ...workflowTrees("same-tree", "same-tree") });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone", "regions-master"), { state: "ready", repo: FORK });

// And an installation that does hold Workflows (write) never has to care.
fakeGitHub({
  ...forkExists,
  ...installedFor(FORK, { contents: "write", workflows: "write" }),
  ...workflowTrees("stale-tree", "current-tree"),
});
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone", "regions-master"), { state: "ready", repo: FORK });

// Without a base to compare against, the question cannot be asked and is not guessed at.
fakeGitHub({ ...forkExists, ...installedFor(FORK) });
assert.deepStrictEqual(await findFork("t", UPSTREAM, "someone"), { state: "ready", repo: FORK });

// An expired token is a signed-out session, not a number to look up.
fakeGitHub({ "/user": { $status: 401, $body: '{"message":"Bad credentials"}' } });
await assert.rejects(whoAmI("stale"), /session expired, sign in again/);

// Throwing the sitting away. A DELETE answers 204 with no body, which used to be read as a
// malformed response and reported as a failure after the branch was already gone.
let del = fakeGitHub({ "DELETE /repos/someone/server/git/refs/heads/regions/2026-08-23": { $noBody: true } });
await deleteBranch("t", FORK, "regions/2026-08-23");
assert.deepStrictEqual(
  del.map(c => `${c.method} ${c.path}`),
  ["DELETE /repos/someone/server/git/refs/heads/regions/2026-08-23"],
  "one call, and the branch name is not mangled by its slash",
);

// --- the pull request title ---

assert.strictEqual(prTitle([ZONE]), "Roam regions: west_ronfaure");
assert.strictEqual(prTitle(["a", "b", "c"]), "Roam regions: a, b, c", "a few are worth naming");
assert.strictEqual(prTitle(["a", "b", "c", "d"]), "Roam regions: 4 zones", "more than a few are worth counting");
assert.strictEqual(prTitle([]), "Roam regions: several zones", "and nothing known is not an empty title");

// --- the pull request body ---

// The template is a file so the wording can be edited without touching code; the cost is that a
// placeholder can be misspelled there, and a silently empty pull request body is the worst way to
// find out. Unknown names survive intact so the mistake is visible in the pull request itself.
assert.strictEqual(
  fillTemplate("drawn with {{editor}} against `{{base}}`", { editor: "the editor", base: "base" }),
  "drawn with the editor against `base`",
);
assert.strictEqual(
  fillTemplate("{{ zone }} and {{zone}}", { zone: "west_ronfaure" }),
  "west_ronfaure and west_ronfaure",
  "spacing inside the braces does not matter",
);
assert.strictEqual(fillTemplate("{{typo}} here", { zone: "x" }), "{{typo}} here", "an unknown name is left alone, not blanked");
assert.strictEqual(fillTemplate("nothing to fill", {}), "nothing to fill");

// and the template that actually ships has to be fillable by what the editor passes it
const template = readFileSync(new URL("./pr_template.md", import.meta.url), "utf8");
const filled = fillTemplate(template, {
  editor: "E",
  zone: "Z",
  base: "B",
  diff: "D",
  regions: "1",
  spawns: "2",
  zones: "- [Z](D)",
});
assert.doesNotMatch(filled, /\{\{/, `pr_template.md has a placeholder nothing fills: ${filled.match(/\{\{\w+\}\}/g)}`);
// The body a sitting actually produces: one line per zone with its own diff link, since a pull
// request covers every zone touched that day and a link into the middle of it helps nobody.
const listed = fillTemplate(template, {
  editor: "E",
  zones: [
    "- [west_ronfaure](D1) (1 region, 1 spawn placed)",
    "- [toraimarai_canal](D2) (1 region, 0 spawns placed)",
  ].join("\n"),
});
assert.match(listed, /^- \[west_ronfaure\]\(D1\) \(1 region, 1 spawn placed\)$/m);
assert.match(listed, /^- \[toraimarai_canal\]\(D2\) \(1 region, 0 spawns placed\)$/m);
assert.doesNotMatch(listed, /\{\{/, "and nothing was left unfilled");

// Deliberately not asserting which placeholders the template uses: the prose is the maintainer's
// to edit, and dropping one is a valid edit. What must hold is that whatever it does use is fed.

console.log("ok");
