import { useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import RegionDiffViewer, { STATUS_COLOR } from "../components/region_diff_viewer";
import zones from "../data/zones";
import { diffRegions, parseMobsYaml, parseRegionsYaml, zoneOfMobId } from "../regions";
import type { RegionsDiff, ZoneSide } from "../regions";
import { loadRoam, trailOf } from "../roam";
import { isTyping } from "../util";
import { loadNavMesh, loadZoneMesh } from "../zone_mesh";

const DEFAULT_REPO = "sruon/server";
const DEFAULT_BASE = "regions-master";
const ZONES = "data/zones";

const raw = (repo: string, ref: string, zone: string, file: string) => `https://raw.githubusercontent.com/${repo}/${ref}/${ZONES}/${zone}/${file}`;

async function side(repo: string, ref: string, zone: string): Promise<ZoneSide> {
  const get = (file: string) => fetch(raw(repo, ref, zone, file)).then(r => (r.ok ? r.text() : null));
  const [regionsYaml, mobsYaml] = await Promise.all([get("regions.yaml"), get("mobs.yaml")]);
  // A ref that predates the zone reads as empty, so everything in the other one counts as added.
  if (!mobsYaml) return { regions: {}, spawns: [] };
  return { regions: regionsYaml ? parseRegionsYaml(regionsYaml) : {}, spawns: parseMobsYaml(mobsYaml) };
}

export default function RegionsDiffPage() {
  // A pull request here is nearly always across forks: the base lives in the staging repository and
  // the head on a contributor's own fork. Reading both refs out of one repository only ever worked
  // for the maintainer, whose fork *is* the staging repository -- for anybody else the base branch
  // does not exist on their fork, so every region read as newly added.
  const [query, setQuery] = useSearchParams<
    { repo?: string; head_repo?: string; base?: string; head?: string; zone?: string; }
  >();
  const repo = () => query.repo || DEFAULT_REPO;
  const headRepo = () => query.head_repo || repo();
  const [error, setError] = createSignal<string | undefined>();
  const [status, setStatus] = createSignal<string | undefined>();
  const [focus, setFocus] = createSignal<{ name?: string; spawn?: string; } | undefined>();
  // Escape steps back out to the whole zone, from a region or a move.
  onMount(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !isTyping(ev.target)) setFocus(undefined);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Branches to compare, and the zones each ref carries.
  const branchesIn = async (name: string) => {
    const list = await fetch(`https://api.github.com/repos/${name}/branches?per_page=100`).then(r => r.json());
    return (Array.isArray(list) ? list : []).map((b: any) => b.name as string).sort();
  };

  const [baseBranches] = createResource(repo, branchesIn);
  const [headBranches] = createResource(headRepo, async name => {
    const names = await branchesIn(name);
    // Both in one call: two setQuery in a row race, and the second wins with a stale location.
    setQuery({
      base: query.base ?? DEFAULT_BASE,
      head: query.head ?? names.find(n => n.startsWith("regions/")),
    }, { replace: true });
    return names;
  });
  /**
   * Branch names for one side, with the branch actually in use always among them.
   *
   * A repository can have far more branches than one page holds -- the staging repository has over
   * a hundred, and regions-master is not on the first -- so the branch being compared could be
   * missing from its own picker, which then showed "pick a branch" over a perfectly good
   * comparison. What is selected is a fact, whether or not the list happens to mention it.
   */
  const branchesFor = (which: "base" | "head") => {
    const names = (which === "base" ? baseBranches() : headBranches()) ?? [];
    const chosen = query[which];
    return chosen && !names.includes(chosen) ? [chosen, ...names] : names;
  };

  /**
   * The zones this comparison actually touches, which is the question a reviewer opens the page
   * with. Picking from every zone in the repository meant knowing the answer already.
   */
  const [changed] = createResource(
    () => (query.base && query.head ? { base: query.base, head: query.head, from: repo(), to: headRepo() } : undefined),
    async ({ base, head, from, to }) => {
      // Across forks the head is named owner:repo:branch; within one repository it is just a ref.
      const [owner, name] = to.split("/");
      const spec = to === from ? head : `${owner}:${name}:${head}`;
      const res = await fetch(`https://api.github.com/repos/${from}/compare/${base}...${spec}`);
      if (!res.ok) throw new Error(`comparing ${base} with ${head} → HTTP ${res.status}`);
      const body = await res.json() as { files?: { filename: string; additions: number; deletions: number; }[]; };

      const perZone = new Map<string, { zone: string; additions: number; deletions: number; files: number; }>();
      for (const file of body.files ?? []) {
        const parts = file.filename.split("/");
        if (parts[0] !== "data" || parts[1] !== "zones" || parts.length < 4) continue;
        const zone = parts[2];
        const seen = perZone.get(zone) ?? { zone, additions: 0, deletions: 0, files: 0 };
        seen.additions += file.additions ?? 0;
        seen.deletions += file.deletions ?? 0;
        seen.files += 1;
        perZone.set(zone, seen);
      }
      return [...perZone.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    },
  );

  // The zones worth offering are the ones the head carries, so this reads the head's repository.
  const [zoneList] = createResource(
    () => (query.head ? { repo: headRepo(), ref: query.head } : undefined),
    async ({ repo, ref }) => {
      const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
      const json = (await res.json()) as { tree?: { path: string; }[]; };
      const wanted = new RegExp(`^${ZONES}/([^/]+)/mobs\\.yaml$`);
      return (json.tree ?? []).map(e => e.path.match(wanted)?.[1]).filter((n): n is string => !!n).sort();
    },
  );

  const [pair] = createResource(
    () => (query.base && query.head && query.zone ? { base: query.base, head: query.head, zone: query.zone } : undefined),
    async ({ base, head, zone }) => {
      setError(undefined);
      setStatus(`Loading ${zone}…`);
      try {
        const [a, b] = await Promise.all([side(repo(), base, zone), side(headRepo(), head, zone)]);
        setStatus(undefined);
        return { base: a, head: b, diff: diffRegions(a, b) };
      } catch (e) {
        setStatus(undefined);
        setError(`${zone}: ${e}`);
        throw e;
      }
    },
  );

  // Which zones of this comparison have been looked at, kept in the browser per branch, so a
  // review that spans a sitting or two knows where it got to. A tick, not a verdict.
  const reviewedKey = () => `reviewed:${headRepo()}:${query.head}`;
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
    localStorage.setItem(reviewedKey(), JSON.stringify(next));
  };

  const zoneId = () => {
    const first = pair()?.head.spawns[0] ?? pair()?.base.spawns[0];
    return first ? zoneOfMobId(first.id) : undefined;
  };
  const [mesh] = createResource(zoneId, id => loadZoneMesh(id, setStatus));
  // The navmesh is what the server walks mobs on, so a vertex that looks fine on the collision
  // mesh can still be off it. Off by default: it is another few MB a zone.
  const [showNav, setShowNav] = createSignal(false);
  const [nav] = createResource(() => (showNav() ? zoneId() : undefined), id => loadNavMesh(id, setStatus));
  const [roam] = createResource(zoneId, loadRoam);

  // Where the mob being looked at was actually seen going, or every mob a picked region places.
  // A move that reads as too far on the map is a question the trail answers at once.
  const trail = () => {
    const data = roam(), want = focus(), sides = pair();
    if (!data || !want || !sides) return undefined;
    const ids = want.spawn
      ? [want.spawn]
      : sides[sides.diff.removed.includes(want.name!) ? "base" : "head"].spawns.filter(s => s.regions?.includes(want.name!)).map(s => s.id);
    return trailOf(data, ids);
  };

  const total = (d: RegionsDiff) => d.added.length + d.removed.length + d.reshaped.length + d.moved.length;
  const swatch = (kind: keyof typeof STATUS_COLOR) => `#${STATUS_COLOR[kind].toString(16)}`;

  // What a maintainer wants off a glance is not the geometry, it is the blast radius: how many mobs
  // this region places and where any of them went. A region that shrank by half with nothing in it
  // is nothing; one that lost nine mobs to no region at all is worth stopping on.
  const picked = () => focus()?.name;
  const pickedKind = (): keyof typeof STATUS_COLOR => {
    const name = picked(), d = pair()?.diff;
    if (!name || !d) return "unchanged";
    return d.added.includes(name) ? "added" : d.removed.includes(name) ? "removed" : "reshaped";
  };
  const pickedChange = () => pair()?.diff.reshaped.find(c => c.name === picked());
  const pickedHeld = (side: "base" | "head") => pair()?.[side].spawns.filter(sp => sp.regions?.includes(picked()!)).length ?? 0;
  // A move names its regions joined with ", ": a mob given several is in each of them.
  const names = (joined?: string) => joined?.split(", ") ?? [];
  const pickedIn = () => pair()?.diff.moved.filter(m => names(m.to).includes(picked()!)) ?? [];
  const pickedOut = () => pair()?.diff.moved.filter(m => names(m.from).includes(picked()!)) ?? [];
  const pickedWentTo = () => [...new Set(pickedOut().map(m => m.to ?? "no region"))];
  const pickedVertices = () => pair()?.[pickedKind() === "removed" ? "base" : "head"].regions[picked() ?? ""]?.rings[0]?.length ?? 0;

  createEffect(() => {
    if (baseBranches.error) setError(`${repo()}: ${baseBranches.error}`);
    else if (headBranches.error) setError(`${headRepo()}: ${headBranches.error}`);
  });

  return (
    <section class="p-8">
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <h1 class="text-2xl font-bold mr-2">Regions Diff</h1>
        {/* query[which] is read inside the JSX so the value tracks; an array literal would snapshot it */}
        <For each={["base", "head"] as const}>
          {which => (
            <label class="flex items-center gap-2">
              <span class="text-slate-400" title={which === "base" ? repo() : headRepo()}>
                {which} <span class="text-slate-600">{which === "base" ? repo() : headRepo()}</span>
              </span>
              <Picker options={branchesFor(which)} value={query[which]} empty="pick a branch" onChange={v => setQuery({ [which]: v })} />
            </label>
          )}
        </For>
        <Show when={changed()}>
          <span class="text-slate-400">
            {changed()!.length ? `${changed()!.length} zone${changed()!.length === 1 ? "" : "s"} changed` : "nothing changed"}
          </span>
        </Show>
        <Show when={changed.loading}>
          <span class="text-slate-500">comparing…</span>
        </Show>
        {/* Every zone in the repository is still reachable, for looking at one nothing touched. */}
        <Picker
          options={zoneList() ?? []}
          value={query.zone}
          empty="any other zone"
          onChange={v => setQuery({ zone: v })}
        />
        <Show when={pair()}>
          <span class="text-slate-400">
            {zones[zoneId()!]?.name ?? "?"} · {total(pair()!.diff) || "no"} changes
          </span>
          {
            /* The diff says what moved; the editor says whether it should have. Roam trails are the
              evidence the regions were drawn from, and they are only over there. */
          }
          <a
            class="px-2 py-1 rounded no-underline whitespace-nowrap bg-slate-700 hover:bg-slate-600 text-white"
            href={`#/regions/${query.zone}?repo=${headRepo()}&ref=${query.head}&review=1`}
            title="Open this zone's proposed version in the editor, over the roam data, without being able to change it"
          >
            Open in editor
          </a>
        </Show>
        <Show when={status()}>
          <span class="text-slate-400">{status()}</span>
        </Show>
        <Show when={zoneId()}>
          <span class="text-slate-500">{roam.error ? "no roam data for this zone" : roam.loading ? "loading roam data…" : ""}</span>
          <label class="flex items-center gap-2 text-slate-400 cursor-pointer" title="Draw the server's navmesh in place of the collision mesh">
            <input type="checkbox" checked={showNav()} onChange={e => setShowNav(e.currentTarget.checked)} />
            navmesh
            <Show when={showNav() && nav.error}>
              <span class="text-slate-500">none for this zone</span>
            </Show>
          </label>
        </Show>
        <Show when={error()}>
          <span class="text-red-500">{error()}</span>
        </Show>
      </div>

      <div class="flex gap-4 mt-4" style={{ height: "78vh" }}>
        {
          /* What the comparison touches, in one place. A reviewer arrives knowing a pull request
            changed something and not where, and picking from every zone in the repository asked
            them to already know. Ordered by size, so the biggest change is the first thing read. */
        }
        <Show when={changed()?.length}>
          <div class="w-60 shrink-0 flex flex-col bg-slate-800 rounded-lg p-2 overflow-y-auto text-sm">
            <div class="text-xs uppercase tracking-wide text-slate-500 px-1 pb-1">
              zones changed ({changed()!.length})
              <Show when={reviewed().length}>
                <span class="text-emerald-500">· {changed()!.filter(z => reviewed().includes(z.zone)).length} reviewed</span>
              </Show>
            </div>
            <For each={changed()}>
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

        <Show
          when={pair() && mesh()}
          fallback={
            <div class="flex-1 text-slate-400">
              {changed()?.length ? "Pick a zone from the list to see what changed in it." : "Pick two branches to compare."}
            </div>
          }
        >
          <div class="flex-1 relative">
            <RegionDiffViewer
              zoneData={mesh()!}
              base={pair()!.base}
              head={pair()!.head}
              diff={pair()!.diff}
              focus={focus()}
              trail={trail()}
              nav={showNav() && !nav.loading && !nav.error ? nav() : undefined}
              onPick={name => setFocus({ name })}
            />
            {
              /* What a maintainer wants off a glance is not the geometry, it is the blast radius:
                how many mobs this region places and where any of them went. A region that shrank by
                half with nothing in it is nothing; one that lost nine mobs to no region at all is
                the thing worth stopping on. */
            }
            <Show when={picked()}>
              <div class="absolute top-2 left-2 bg-slate-900/90 rounded px-3 py-2 text-sm max-w-96">
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
                      {" · "}area {pickedChange()!.areaRatio >= 1 ? "+" : ""}
                      {((pickedChange()!.areaRatio - 1) * 100).toFixed(0)}%
                    </Show>
                    <Show when={pickedChange()!.toHoles !== pickedChange()!.fromHoles}>
                      {" · "}
                      <span class="text-amber-300">
                        {pickedChange()!.toHoles > pickedChange()!.fromHoles ? "+" : "−"}
                        {Math.abs(pickedChange()!.toHoles - pickedChange()!.fromHoles)} hole
                        {Math.abs(pickedChange()!.toHoles - pickedChange()!.fromHoles) === 1 ? "" : "s"}
                      </span>
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

            {/* Two pins and a line between them say a move happened; this says which way and whose. */}
            <Show when={focus()?.spawn && pair()!.diff.moved.find(m => m.id === focus()!.spawn)}>
              {found => (
                <div class="absolute top-2 left-2 bg-slate-900/85 rounded px-3 py-2 text-sm pointer-events-none">
                  <span class="text-slate-300">{found().name}</span> <span class="text-slate-500">{found().id}</span>
                  <div class="mt-1">
                    <span style={{ color: swatch("removed") }}>{found().from ?? "no region"}</span>
                    <span class="text-slate-400">→</span>
                    <span style={{ color: swatch("added") }}>{found().to ?? "no region"}</span>
                  </div>
                  <Show when={roam() && !roam()!.ranges[found().id]}>
                    <div class="text-slate-500">no roam trail recorded for it</div>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          <div class="w-96 flex flex-col bg-slate-800 rounded-lg p-2 overflow-y-auto text-sm">
            <Show when={total(pair()!.diff) === 0}>
              <div class="text-emerald-500 p-2">These two are identical.</div>
            </Show>

            <For each={pair()!.diff.added}>
              {name => (
                <DiffRow color={swatch("added")} mark="+" onClick={() => setFocus({ name })}>
                  <b>{name}</b> added, {pair()!.head.regions[name].rings[0]?.length ?? 0} vertices,{" "}
                  {pair()!.head.spawns.filter(s => s.regions?.includes(name)).length} spawns
                </DiffRow>
              )}
            </For>
            <For each={pair()!.diff.removed}>
              {name => (
                <DiffRow color={swatch("removed")} mark="−" onClick={() => setFocus({ name })}>
                  <b>{name}</b> removed, held {pair()!.base.spawns.filter(s => s.regions?.includes(name)).length} spawns
                </DiffRow>
              )}
            </For>
            <For each={pair()!.diff.reshaped}>
              {change => (
                <DiffRow color={swatch("reshaped")} mark="~" onClick={() => setFocus({ name: change.name })}>
                  <b>{change.name}</b> {
                    /* Say the thing that changed. An outline untouched to the vertex with a hole cut
                      out of it used to read "33 to 33 vertices, area +0%", which is a way of saying
                      nothing at all. */
                  }
                  <Show
                    when={change.fromVertices !== change.toVertices || Math.abs(change.areaRatio - 1) > 0.005}
                    fallback={<>outline unchanged</>}
                  >
                    reshaped, {change.fromVertices} → {change.toVertices} vertices, area {change.areaRatio >= 1 ? "+" : ""}
                    {((change.areaRatio - 1) * 100).toFixed(0)}%
                  </Show>
                  <Show when={change.toHoles !== change.fromHoles}>
                    <span class="text-amber-300">
                      , {change.toHoles > change.fromHoles ? "+" : "−"}
                      {Math.abs(change.toHoles - change.fromHoles)} hole{Math.abs(change.toHoles - change.fromHoles) === 1 ? "" : "s"}
                    </span>
                  </Show>
                </DiffRow>
              )}
            </For>
            <Show when={pair()!.diff.moved.length}>
              <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">
                {pair()!.diff.moved.length} spawns moved
              </div>
              <For each={pair()!.diff.moved}>
                {move => (
                  <DiffRow color={swatch("reshaped")} mark="~" onClick={() => setFocus({ spawn: move.id })}>
                    <span class="text-slate-300">{move.name}</span> <span class="text-slate-500">{move.id}</span> {move.from ?? "unmapped"} →{" "}
                    {move.to ?? "unmapped"}
                  </DiffRow>
                )}
              </For>
            </Show>
            <Show when={pair()!.diff.addedSpawns.length || pair()!.diff.removedSpawns.length}>
              <div class="text-xs text-slate-500 mt-2 px-1">
                mobs.yaml itself changed: {pair()!.diff.addedSpawns.length} spawns added, {pair()!.diff.removedSpawns.length} removed
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  );
}

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

function DiffRow(props: { color: string; mark: string; onClick: () => void; children: any; }) {
  return (
    <div class="flex gap-2 py-0.5 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs" onClick={props.onClick}>
      <span style={{ color: props.color }}>{props.mark}</span>
      <span class="text-slate-300">{props.children}</span>
    </div>
  );
}
