import { useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, ErrorBoundary, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import RegionDiffViewer, { STATUS_COLOR } from "../components/region_diff_viewer";
import zones, { zoneOfFolder } from "../data/zones";
import { ghPublic, ghPublicPages, parsePr, rawUrl, UPSTREAM, UPSTREAM_BASE, ZONES_DIR } from "../github";
import { storedToken } from "../github_auth";
import { diffRegions, parseMobsYaml, parseRegionsYaml, zoneOfMobId } from "../regions";
import type { RegionsDiff, ZoneSide } from "../regions";
import { loadRoam, trailOf } from "../roam";
import { css } from "../theme";
import { isMissing, isTyping } from "../util";
import { loadNavMesh, loadZoneMesh } from "../zone_mesh";

/**
 * One side of the comparison, read at a commit. A 404 is the zone not existing there, which on the
 * base side is a zone the change adds; anything else is a failed read, and treating that as an
 * empty zone used to show every region as added with no error at all.
 */
async function side(repo: string, sha: string, zone: string, required: boolean): Promise<ZoneSide> {
  const get = async (file: string) => {
    const res = await fetch(rawUrl(repo, sha, `${ZONES_DIR}/${zone}/${file}`));
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    throw new Error(`${file} at ${repo}@${sha.slice(0, 7)} → HTTP ${res.status}`);
  };
  const [regionsYaml, mobsYaml] = await Promise.all([get("regions.yaml"), get("mobs.yaml")]);
  if (!mobsYaml) {
    if (required) throw new Error(`${zone} has no mobs.yaml at ${repo}@${sha.slice(0, 7)}`);
    return { regions: {}, spawns: [] };
  }
  return { regions: regionsYaml ? parseRegionsYaml(regionsYaml) : {}, spawns: parseMobsYaml(mobsYaml) };
}

interface ZoneChange {
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
interface Comparison {
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
  zones: ZoneChange[];
  /** The listing stopped short, so there may be zones changed that are not in it. */
  partial: boolean;
  pr?: { number: number; title: string; url: string; state: string; merged: boolean; };
}

const zonesTouched = (files: { filename: string; additions?: number; deletions?: number; }[]): ZoneChange[] => {
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

export default function RegionsDiffPage() {
  // Two ways in: a pull request (?pr=1234, or a pasted link), which is what a reviewer has, or two
  // branches, which is what the editor links to before a pull request exists. A branch comparison
  // is nearly always across forks: base on the upstream repository, head on a contributor's fork.
  const [query, setQuery] = useSearchParams<
    { pr?: string; repo?: string; head_repo?: string; base?: string; head?: string; zone?: string; }
  >();
  const token = () => storedToken()?.token;
  const pr = () => (query.pr ? parsePr(query.pr, query.repo || UPSTREAM) : undefined);
  const repo = () => query.repo || UPSTREAM;
  const headRepo = () => query.head_repo || repo();
  const branchMode = () => !pr() && !!(query.head || query.head_repo);
  const [error, setError] = createSignal<string | undefined>();
  const [status, setStatus] = createSignal<string | undefined>();
  const [focus, setFocus] = createSignal<{ name?: string; spawn?: string; } | undefined>();
  const [pasted, setPasted] = createSignal("");
  // Escape steps back out to the whole zone, from a region or a move. j and k step through the
  // changes in the list, [ and ] through the zones, so a review can be read without the mouse.
  onMount(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "Escape") return setFocus(undefined);
      if (ev.key === "j" || ev.key === "k") return stepChange(ev.key === "j" ? 1 : -1);
      if (ev.key === "]" || ev.key === "[") return stepZone(ev.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  // A region picked in one zone means nothing in the next.
  createEffect(on(() => query.zone, () => setFocus(undefined), { defer: true }));

  const openPr = () => {
    const found = parsePr(pasted(), repo());
    if (!found) return setError("That is not a pull request link or number");
    setError(undefined);
    setQuery({ pr: found.repo === UPSTREAM ? String(found.number) : `${found.repo}#${found.number}`, repo: undefined, zone: undefined });
  };

  // Branch pickers, for branch mode only. Upstream has hundreds of branches, so a few pages of them.
  const branchesIn = async (name: string) => (await ghPublicPages(`/repos/${name}/branches`, token(), 5)).map((b: any) => b.name as string).sort();
  const [baseBranches] = createResource(() => (branchMode() ? repo() : undefined), branchesIn);
  const [headBranches] = createResource(() => (branchMode() ? headRepo() : undefined), branchesIn);
  /** Branch names for one side, with the branch actually in use always among them. */
  const branchesFor = (which: "base" | "head") => {
    const names = (which === "base" ? baseBranches() : headBranches()) ?? [];
    const chosen = which === "base" ? query.base || UPSTREAM_BASE : query.head;
    return chosen && !names.includes(chosen) ? [chosen, ...names] : names;
  };

  const [comparison] = createResource(
    () => pr() ?? (branchMode() && query.head ? { base: query.base || UPSTREAM_BASE, head: query.head, from: repo(), to: headRepo() } : undefined),
    async (what): Promise<Comparison> => {
      if ("number" in what) {
        const pull = await ghPublic(`/repos/${what.repo}/pulls/${what.number}`, token());
        const baseRepo = pull.base.repo.full_name as string;
        // From the base commit the pull request was last compared against, not the branch tip: a
        // merged pull request's base has moved past it, and so has an open one's, often.
        const cmp = await ghPublic(`/repos/${baseRepo}/compare/${pull.base.sha}...${pull.head.sha}`, token());
        // Up to 3000 files, where compare stops at 300.
        const files = await ghPublicPages(`/repos/${baseRepo}/pulls/${what.number}/files`, token());
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
      const [owner, name] = what.to.split("/");
      const spec = what.to === what.from ? what.head : `${owner}:${name}:${what.head}`;
      const cmp = await ghPublic(`/repos/${what.from}/compare/${encodeURIComponent(what.base)}...${encodeURIComponent(spec)}`, token()).catch(e => {
        throw e.status === 404 ? new Error(`could not compare ${what.base} with ${what.to}:${what.head}; is the branch still there?`) : e;
      });
      const mergeBase = cmp.merge_base_commit?.sha as string;
      return {
        baseRepo: what.from,
        baseSha: mergeBase,
        headRepo: what.to,
        // Nothing ahead means the head is an ancestor of base, and so is where they meet.
        headSha: cmp.commits?.at(-1)?.sha ?? mergeBase,
        baseName: what.base,
        headName: what.head,
        zones: zonesTouched(cmp.files ?? []),
        partial: (cmp.files?.length ?? 0) >= 300,
      };
    },
  );
  const cmp = () => (comparison.state === "ready" ? comparison() : undefined);

  // Every zone folder on the head side, for looking at one the change did not touch. Only fetched
  // once somebody opens that picker: it is a request most reviews never need.
  const [wantAllZones, setWantAllZones] = createSignal(false);
  const [zoneList] = createResource(
    () => (wantAllZones() && cmp() ? { repo: cmp()!.headRepo, sha: cmp()!.headSha } : undefined),
    async ({ repo, sha }) => {
      const tree = await ghPublic(`/repos/${repo}/git/trees/${sha}:${ZONES_DIR}`, token());
      return ((tree.tree ?? []) as { path: string; type: string; }[]).filter(e => e.type === "tree").map(e => e.path).sort();
    },
  );

  const [pair] = createResource(
    () => (cmp() && query.zone ? { c: cmp()!, zone: query.zone } : undefined),
    async ({ c, zone }) => {
      setStatus(`Loading ${zone}…`);
      try {
        const [a, b] = await Promise.all([side(c.baseRepo, c.baseSha, zone, false), side(c.headRepo, c.headSha, zone, true)]);
        return { base: a, head: b, diff: diffRegions(a, b) };
      } finally {
        setStatus(undefined);
      }
    },
  );
  const sides = () => (pair.state === "ready" ? pair() : undefined);

  // Which zones of this comparison have been looked at, kept in the browser per head commit, so a
  // push after the review un-ticks what it could have changed. A tick, not a verdict.
  const reviewedKey = () => `reviewed:${cmp()?.headRepo}:${cmp()?.headSha}`;
  const [reviewed, setReviewed] = createSignal<string[]>([]);
  createEffect(() => {
    try {
      setReviewed(JSON.parse(localStorage.getItem(reviewedKey()) ?? "[]"));
    } catch {
      setReviewed([]);
    }
  });
  const toggleReviewed = (zone: string) => {
    const next = reviewed().includes(zone) ? reviewed().filter(z => z !== zone) : [...reviewed(), zone];
    setReviewed(next);
    try {
      localStorage.setItem(reviewedKey(), JSON.stringify(next));
    } catch {
      // A tick that does not survive a reload is not worth an error.
    }
  };

  const zoneId = () => {
    const first = sides()?.head.spawns[0] ?? sides()?.base.spawns[0];
    return first ? zoneOfMobId(first.id) : sides() && query.zone ? zoneOfFolder(query.zone)?.id : undefined;
  };
  const [mesh] = createResource(zoneId, id => loadZoneMesh(id, setStatus));
  // The navmesh is what the server walks mobs on, so a vertex that looks fine on the collision
  // mesh can still be off it. Off by default: it is another few MB a zone.
  const [showNav, setShowNav] = createSignal(false);
  const [nav] = createResource(() => (showNav() ? zoneId() : undefined), id => loadNavMesh(id, setStatus));
  const [roam] = createResource(zoneId, loadRoam);
  const roamData = () => (roam.state === "ready" ? roam() : undefined);

  // Where the mob being looked at was actually seen going, or every mob a picked region places.
  // A move that reads as too far on the map is a question the trail answers at once.
  const trail = () => {
    const data = roamData(), want = focus(), both = sides();
    if (!data || !want || !both) return undefined;
    const ids = want.spawn
      ? [want.spawn]
      : both[both.diff.removed.includes(want.name!) ? "base" : "head"].spawns.filter(s => s.regions?.includes(want.name!)).map(s => s.id);
    return trailOf(data, ids);
  };

  /** Everything the list offers to pick, in the order it lists it. */
  const changeList = (): { name?: string; spawn?: string; }[] => {
    const d = sides()?.diff;
    if (!d) return [];
    return [
      ...[...d.added, ...d.removed, ...d.reshaped.map(c => c.name)].map(name => ({ name })),
      ...[...d.moved, ...d.rerouted, ...d.relocated].map(m => ({ spawn: m.id })),
    ];
  };
  const stepChange = (dir: 1 | -1) => {
    const list = changeList();
    if (!list.length) return;
    const now = focus();
    const at = list.findIndex(c => (c.name && c.name === now?.name) || (c.spawn && c.spawn === now?.spawn));
    setFocus(list[at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length]);
  };
  const stepZone = (dir: 1 | -1) => {
    const list = cmp()?.zones ?? [];
    if (!list.length) return;
    const at = list.findIndex(z => z.zone === query.zone);
    setQuery({ zone: list[at < 0 ? 0 : (at + dir + list.length) % list.length].zone });
  };

  const total = (d: RegionsDiff) =>
    d.added.length + d.removed.length + d.reshaped.length + d.moved.length + d.rerouted.length + d.relocated.length + d.addedSpawns.length
    + d.removedSpawns.length;
  const swatch = (kind: keyof typeof STATUS_COLOR) => css(STATUS_COLOR[kind]);

  // What a maintainer wants off a glance is not the geometry, it is the blast radius: how many mobs
  // this region places and where any of them went. A region that shrank by half with nothing in it
  // is nothing; one that lost nine mobs to no region at all is worth stopping on.
  const picked = () => focus()?.name;
  const pickedKind = (): keyof typeof STATUS_COLOR => {
    const name = picked(), d = sides()?.diff;
    if (!name || !d) return "unchanged";
    if (d.added.includes(name)) return "added";
    if (d.removed.includes(name)) return "removed";
    return d.reshaped.some(c => c.name === name) ? "reshaped" : "unchanged";
  };
  const pickedChange = () => sides()?.diff.reshaped.find(c => c.name === picked());
  const pickedHeld = (side: "base" | "head") => sides()?.[side].spawns.filter(sp => sp.regions?.includes(picked()!)).length ?? 0;
  // A move names its regions joined with ", ": a mob given several is in each of them.
  const names = (joined?: string) => joined?.split(", ") ?? [];
  const pickedIn = () => sides()?.diff.moved.filter(m => names(m.to).includes(picked()!)) ?? [];
  const pickedOut = () => sides()?.diff.moved.filter(m => names(m.from).includes(picked()!)) ?? [];
  const pickedWentTo = () => [...new Set(pickedOut().map(m => m.to ?? "no region"))];
  const pickedVertices = () => sides()?.[pickedKind() === "removed" ? "base" : "head"].regions[picked() ?? ""]?.rings[0]?.length ?? 0;

  /** The editor, read only, on the head side of this zone. */
  const editorHref = () => {
    const c = cmp();
    if (!c || !query.zone) return undefined;
    return `#/regions/${encodeURIComponent(query.zone)}?${new URLSearchParams({ repo: c.headRepo, ref: c.headSha, review: "1" })}`;
  };

  const problem = () =>
    error()
      ?? (comparison.error && (comparison.error as Error).message)
      ?? (pair.error && `${query.zone}: ${(pair.error as Error).message}`)
      ?? (mesh.error && `zone mesh: ${(mesh.error as Error).message}`)
      ?? (baseBranches.error && `${repo()}: ${(baseBranches.error as Error).message}`)
      ?? (headBranches.error && `${headRepo()}: ${(headBranches.error as Error).message}`);

  return (
    <section class="p-8">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <h1 class="text-2xl font-bold mr-2">Regions Diff</h1>
        <form
          class="flex items-center gap-2"
          onSubmit={e => (e.preventDefault(), openPr())}
        >
          <input
            class="px-2 py-1 bg-slate-700 rounded w-72"
            placeholder="Paste a pull request link or number"
            value={pasted()}
            onInput={e => setPasted(e.currentTarget.value)}
          />
          <button
            class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:hover:bg-emerald-600"
            type="submit"
            disabled={!pasted().trim()}
          >
            Compare
          </button>
        </form>
        <Show when={cmp()?.pr}>
          {p => (
            <a class="text-slate-300 hover:text-white" href={p().url} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
              #{p().number} {p().title} <span class="text-slate-500">({p().merged ? "merged" : p().state})</span>
            </a>
          )}
        </Show>
        <Show when={branchMode()}>
          {/* query is read inside the JSX so the value tracks; an array literal would snapshot it */}
          <For each={["base", "head"] as const}>
            {which => (
              <label class="flex items-center gap-2">
                <span class="text-slate-400" title={which === "base" ? repo() : headRepo()}>
                  {which} <span class="text-slate-600">{which === "base" ? repo() : headRepo()}</span>
                </span>
                <Picker
                  options={branchesFor(which)}
                  value={which === "base" ? query.base || UPSTREAM_BASE : query.head}
                  empty="pick a branch"
                  onChange={v => setQuery({ [which]: v, zone: undefined })}
                />
              </label>
            )}
          </For>
        </Show>
        <Show when={cmp()}>
          <span class="text-slate-400">
            {cmp()!.zones.length ? `${cmp()!.zones.length} zone${cmp()!.zones.length === 1 ? "" : "s"} changed` : "no zone files changed"}
            {cmp()!.partial ? ", maybe more: GitHub lists only so many files" : ""}
          </span>
        </Show>
        <Show when={comparison.loading}>
          <span class="text-slate-500">comparing…</span>
        </Show>
        {/* Every zone is still reachable, for looking at one nothing touched. */}
        <Show when={cmp()}>
          <span onMouseDown={() => setWantAllZones(true)} onFocusIn={() => setWantAllZones(true)}>
            <Picker
              options={zoneList() ?? (query.zone ? [query.zone] : [])}
              value={query.zone}
              empty={zoneList.loading ? "listing zones…" : "any other zone"}
              onChange={v => setQuery({ zone: v })}
            />
          </span>
        </Show>
        <Show when={sides()}>
          <span class="text-slate-400">
            {zones[zoneId()!]?.name ?? query.zone} · {total(sides()!.diff) || "no"} changes
          </span>
          {
            /* The diff says what moved; the editor says whether it should have. Roam trails are the
              evidence the regions were drawn from, and they are only over there. */
          }
          <a
            class="px-2 py-1 rounded no-underline whitespace-nowrap bg-slate-700 hover:bg-slate-600 text-white"
            href={editorHref()}
            title="Open this zone's proposed version in the editor, over the roam data, without being able to change it"
          >
            Open in editor
          </a>
        </Show>
        <Show when={status()}>
          <span class="text-slate-400">{status()}</span>
        </Show>
        <Show when={zoneId()}>
          <span class="text-slate-500">
            {roam.error ? (isMissing(roam.error) ? "no roam data for this zone" : "roam data failed to load") : roam.loading ? "loading roam data…" : ""}
          </span>
          <label class="flex items-center gap-2 text-slate-400 cursor-pointer" title="Draw the server's navmesh in place of the collision mesh">
            <input type="checkbox" checked={showNav()} onChange={e => setShowNav(e.currentTarget.checked)} />
            navmesh
            <Show when={showNav() && nav.error}>
              <span class="text-slate-500">{isMissing(nav.error) ? "none for this zone" : "failed to load"}</span>
            </Show>
          </label>
        </Show>
        <Show when={problem()}>
          <span class="text-red-500">{problem()}</span>
        </Show>
      </div>

      <div class="flex gap-4 mt-4" style={{ height: "78vh" }}>
        {
          /* What the comparison touches, in one place. A reviewer arrives knowing a pull request
            changed something and not where. Ordered by size, so the biggest change is read first. */
        }
        <Show when={cmp()?.zones.length}>
          <div class="w-60 shrink-0 flex flex-col bg-slate-800 rounded-lg p-2 overflow-y-auto text-sm">
            <div class="text-xs uppercase tracking-wide text-slate-500 px-1 pb-1">
              <span title="[ and ] step through the zones, j and k through the changes in one">zones changed ({cmp()!.zones.length})</span>
              <Show when={reviewed().length}>
                <span class="text-emerald-500">· {cmp()!.zones.filter(z => reviewed().includes(z.zone)).length} reviewed</span>
              </Show>
            </div>
            <For each={cmp()!.zones}>
              {z => (
                <div
                  class="flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-slate-700"
                  classList={{ "bg-slate-700": query.zone === z.zone, "text-slate-500": reviewed().includes(z.zone) }}
                  title={`${z.files} file${z.files === 1 ? "" : "s"} changed`}
                  onClick={() => setQuery({ zone: z.zone })}
                >
                  <input
                    type="checkbox"
                    class="shrink-0"
                    checked={reviewed().includes(z.zone)}
                    title="Mark as reviewed"
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggleReviewed(z.zone)}
                  />
                  <span class="flex-1 truncate">{z.zone}</span>
                  <span class="text-emerald-500 tabular-nums">+{z.additions}</span>
                  <span class="text-red-400 tabular-nums">−{z.deletions}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <ErrorBoundary fallback={e => <div class="flex-1 text-red-500">This zone could not be drawn: {(e as Error)?.message ?? String(e)}</div>}>
          <Show
            when={sides() && mesh.state === "ready"}
            fallback={
              <div class="flex-1 text-slate-400">
                <Show
                  when={cmp()}
                  fallback={
                    <Show when={!comparison.loading && !pr() && !branchMode()}>
                      <p>Paste a pull request link or number above to see what it does to the spawn regions, zone by zone.</p>
                      <p class="mt-2 text-slate-500">
                        Regions it added show green, removed red, reshaped amber, drawn over the zone and the mobs' recorded roam trails.
                      </p>
                    </Show>
                  }
                >
                  {cmp()!.zones.length
                    ? query.zone ? (pair.loading || mesh.loading ? "Loading…" : "") : "Pick a zone from the list to see what changed in it."
                    : "This change touches no zone files."}
                </Show>
              </div>
            }
          >
            <div class="flex-1 relative">
              <RegionDiffViewer
                zoneData={mesh()!}
                base={sides()!.base}
                head={sides()!.head}
                diff={sides()!.diff}
                focus={focus()}
                trail={trail()}
                nav={showNav() && nav.state === "ready" ? nav() : undefined}
                onPick={name => setFocus({ name })}
              />
              {/* Below the viewer's legend, which sits in the same corner. */}
              <Show when={picked()}>
                <div class="absolute top-10 left-2 bg-slate-900/90 rounded px-3 py-2 text-sm max-w-96">
                  <div class="flex items-baseline gap-2">
                    <b style={{ color: swatch(pickedKind()) }}>{picked()}</b>
                    <span class="text-slate-400">{pickedKind()}</span>
                  </div>

                  <div class="text-slate-300 mt-1">
                    <Show when={pickedChange()} fallback={<>{pickedVertices()} vertices</>}>
                      <Show when={pickedChange()!.fromVertices !== pickedChange()!.toVertices} fallback={<>outline unchanged</>}>
                        {pickedChange()!.fromVertices} → {pickedChange()!.toVertices} vertices
                      </Show>
                      <Show when={Math.abs(pickedChange()!.areaRatio - 1) > 0.005}>
                        {" · "}
                        {areaChange(pickedChange()!.areaRatio)}
                      </Show>
                      <Show when={pickedChange()!.toHoles !== pickedChange()!.fromHoles}>
                        {" · "}
                        <span class="text-amber-300">{holeChange(pickedChange()!.fromHoles, pickedChange()!.toHoles)}</span>
                      </Show>
                    </Show>
                  </div>

                  {/* The part worth reading first. */}
                  <div class="mt-2 text-slate-200">
                    <Show
                      when={pickedKind() !== "removed"}
                      fallback={
                        <>
                          held <b>{pickedHeld("base")}</b> mob{pickedHeld("base") === 1 ? "" : "s"}
                          <Show when={pickedWentTo().length}>
                            <span class="text-slate-400">, now in</span>
                            <span style={{ color: swatch("added") }}>{pickedWentTo().join(", ")}</span>
                          </Show>
                        </>
                      }
                    >
                      <b>{pickedHeld("head")}</b> mob{pickedHeld("head") === 1 ? "" : "s"} placed here
                      <Show when={pickedIn().length || pickedOut().length}>
                        <span class="text-slate-400">
                          {" ("}
                          <Show when={pickedIn().length}>
                            <span style={{ color: swatch("added") }}>+{pickedIn().length} in</span>
                          </Show>
                          <Show when={pickedIn().length && pickedOut().length}>{", "}</Show>
                          <Show when={pickedOut().length}>
                            <span style={{ color: swatch("removed") }}>−{pickedOut().length} out</span>
                          </Show>
                          {")"}
                        </span>
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>

              {/* Two pins and a line between them say a spawn changed region; this says which way. */}
              <Show when={sides()!.diff.moved.find(m => m.id === focus()?.spawn)}>
                {found => (
                  <div class="absolute top-10 left-2 bg-slate-900/85 rounded px-3 py-2 text-sm pointer-events-none">
                    <span class="text-slate-300">{found().name}</span> <span class="text-slate-500">{found().id}</span>
                    <div class="mt-1">
                      <span style={{ color: swatch("removed") }}>{found().from ?? "no region"}</span>
                      <span class="text-slate-400">→</span>
                      <span style={{ color: swatch("added") }}>{found().to ?? "no region"}</span>
                    </div>
                    <Show when={roamData() && !roamData()!.ranges[found().id]}>
                      <div class="text-slate-500">no roam trail recorded for it</div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>

            <div class="w-96 flex flex-col bg-slate-800 rounded-lg p-2 overflow-y-auto text-sm">
              <div class="text-[10px] text-slate-500 px-1 pb-1">
                <kbd>j</kbd>/<kbd>k</kbd> next or previous change · <kbd>[</kbd>/<kbd>]</kbd> zone · <kbd>esc</kbd> whole zone
              </div>
              <Show when={total(sides()!.diff) === 0}>
                <div class="text-emerald-500 p-2">No region or spawn placement changed in this zone.</div>
              </Show>

              <For each={sides()!.diff.added}>
                {name => (
                  <DiffRow color={swatch("added")} mark="+" active={picked() === name} onClick={() => setFocus({ name })}>
                    <b>{name}</b> added, {sides()!.head.regions[name].rings[0]?.length ?? 0} vertices,{" "}
                    {sides()!.head.spawns.filter(s => s.regions?.includes(name)).length} spawns
                  </DiffRow>
                )}
              </For>
              <For each={sides()!.diff.removed}>
                {name => (
                  <DiffRow color={swatch("removed")} mark="−" active={picked() === name} onClick={() => setFocus({ name })}>
                    <b>{name}</b> removed, held {sides()!.base.spawns.filter(s => s.regions?.includes(name)).length} spawns
                  </DiffRow>
                )}
              </For>
              <For each={sides()!.diff.reshaped}>
                {change => (
                  <DiffRow color={swatch("reshaped")} mark="~" active={picked() === change.name} onClick={() => setFocus({ name: change.name })}>
                    <b>{change.name}</b> {
                      /* Say the thing that changed. An outline untouched to the vertex with a hole cut
                      out of it used to read "33 to 33 vertices, area +0%", which says nothing. */
                    }
                    <Show
                      when={change.fromVertices !== change.toVertices || Math.abs(change.areaRatio - 1) > 0.005}
                      fallback={<>outline unchanged</>}
                    >
                      reshaped, {change.fromVertices} → {change.toVertices} vertices, {areaChange(change.areaRatio)}
                    </Show>
                    <Show when={change.toHoles !== change.fromHoles}>
                      <span class="text-amber-300">, {holeChange(change.fromHoles, change.toHoles)}</span>
                    </Show>
                  </DiffRow>
                )}
              </For>
              <Show when={sides()!.diff.moved.length}>
                <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">
                  {sides()!.diff.moved.length} spawns reassigned
                </div>
                <For each={sides()!.diff.moved}>
                  {move => (
                    <DiffRow color={swatch("reshaped")} mark="→" active={focus()?.spawn === move.id} onClick={() => setFocus({ spawn: move.id })}>
                      <span class="text-slate-300">{move.name}</span> <span class="text-slate-500">{move.id}</span> {move.from ?? "no region"} →{" "}
                      {move.to ?? "no region"}
                    </DiffRow>
                  )}
                </For>
              </Show>
              <Show when={sides()!.diff.rerouted.length}>
                <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">{sides()!.diff.rerouted.length} routes changed</div>
                <For each={sides()!.diff.rerouted}>
                  {r => (
                    <DiffRow color={swatch("reshaped")} mark="↻" active={focus()?.spawn === r.id} onClick={() => setFocus({ spawn: r.id })}>
                      <span class="text-slate-300">{r.name}</span> <span class="text-slate-500">{r.id}</span>{" "}
                      {r.fromLegs ? (r.toLegs ? `${r.fromLegs} → ${r.toLegs} legs` : "route removed") : `given a ${r.toLegs} leg route`}
                    </DiffRow>
                  )}
                </For>
              </Show>
              <Show when={sides()!.diff.relocated.length}>
                <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">{sides()!.diff.relocated.length} fixed points moved</div>
                <For each={sides()!.diff.relocated}>
                  {r => (
                    <DiffRow color={swatch("reshaped")} mark="~" active={focus()?.spawn === r.id} onClick={() => setFocus({ spawn: r.id })}>
                      <span class="text-slate-300">{r.name}</span> <span class="text-slate-500">{r.id}</span>
                    </DiffRow>
                  )}
                </For>
              </Show>
              <Show when={sides()!.diff.addedSpawns.length || sides()!.diff.removedSpawns.length}>
                <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">spawns in mobs.yaml</div>
                <For each={sides()!.diff.addedSpawns}>
                  {id => (
                    <DiffRow color={swatch("added")} mark="+" active={false} onClick={() => {}}>
                      <span class="text-slate-300">{sides()!.head.spawns.find(s => s.id === id)?.name ?? id}</span> <span class="text-slate-500">{id}</span>
                      {" "}
                      added
                    </DiffRow>
                  )}
                </For>
                <For each={sides()!.diff.removedSpawns}>
                  {id => (
                    <DiffRow color={swatch("removed")} mark="−" active={false} onClick={() => {}}>
                      <span class="text-slate-300">{sides()!.base.spawns.find(s => s.id === id)?.name ?? id}</span> <span class="text-slate-500">{id}</span>
                      {" "}
                      removed
                    </DiffRow>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </ErrorBoundary>
      </div>
    </section>
  );
}

/** "area +12%", or what a region with no area before it actually is. */
const areaChange = (ratio: number) => Number.isFinite(ratio) ? `area ${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}%` : "had no area before";

const holeChange = (from: number, to: number) => {
  const n = Math.abs(to - from);
  return `${to > from ? "+" : "−"}${n} hole${n === 1 ? "" : "s"}`;
};

/** A select whose value is re-applied once its options exist; setting it earlier is a no-op. */
function Picker(props: { options: string[]; value?: string; empty: string; onChange: (value: string) => void; }) {
  let el!: HTMLSelectElement;
  createEffect(() => {
    el.value = props.options.includes(props.value ?? "") ? props.value! : "";
  });
  return (
    <select ref={el} class="px-2 py-1 bg-slate-700 rounded max-w-56" onChange={e => props.onChange(e.currentTarget.value)}>
      <option value="">{props.empty}</option>
      <For each={props.options}>{o => <option value={o}>{o}</option>}</For>
    </select>
  );
}

function DiffRow(props: { color: string; mark: string; active: boolean; onClick: () => void; children: JSX.Element; }) {
  return (
    <div
      class="flex gap-2 py-0.5 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs"
      classList={{ "bg-slate-700": props.active }}
      onClick={props.onClick}
    >
      <span style={{ color: props.color }}>{props.mark}</span>
      <span class="text-slate-300">{props.children}</span>
    </div>
  );
}
