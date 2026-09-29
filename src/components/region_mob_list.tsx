import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Patrol, Spawn } from "../regions";

export type MobStatus = "region" | "route" | "fixed" | "nowhere";

/** What places this mob, which is the whole question the editor exists to answer. */
export function statusOf(spawn: Spawn, region: string[] | undefined, patrol: Patrol | undefined): MobStatus {
  if (region?.length) return "region";
  if (patrol) return "route";
  return spawn.at ? "fixed" : "nowhere";
}

const FILTERS: { key: MobStatus | "all"; label: string; }[] = [
  { key: "all", label: "All" },
  { key: "region", label: "Region" },
  { key: "route", label: "Route" },
  { key: "fixed", label: "Fixed" },
  { key: "nowhere", label: "None" },
];

interface MobListProps {
  spawns: Spawn[];
  assign: Record<string, string[]>;
  paths: Record<string, Patrol>;
  /** Roam sample counts by spawn id, so it is obvious which mobs there is anything to go on for. */
  samples: (id: string) => number;
  colorOf: (region: string) => string;
  activeName: string | null;
  pinnedId: string | null;
  onHover: (id: string | null) => void;
  onPin: (id: string) => void;
  onCentre: (spawn: Spawn) => void;
  /** add is true when shift was held: keep the regions it already has and name another. */
  onAssign: (spawn: Spawn, add: boolean) => void;
  onMenu: (spawn: Spawn, x: number, y: number) => void;
  /** Narrows the list to a floor when one is picked, so the counts answer what is left on it. */
  visible: (spawn: Spawn) => boolean;
  onBuildRegion: (spawns: Spawn[]) => void;
  canBuild: boolean;
  readOnly?: boolean;
}

/**
 * Every mob in the zone and what places it. The editing tabs on the other side each show one slice
 * of this, which left no view of the whole thing: whether a zone is done is a question about all of
 * its mobs at once, and it was only answerable by counting tabs against each other.
 */
export default function MobList(props: MobListProps) {
  const [filter, setFilter] = createSignal("");
  const [status, setStatus] = createSignal<MobStatus | "all">("all");
  const [open, setOpen] = createSignal(true);
  const [copied, setCopied] = createSignal<string | null>(null);

  let flash: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flash));

  // Alt-click a row to put its id on the clipboard. The id is the one thing here that gets typed
  // back into the yaml or a query by hand, and reading nine digits off the screen invites the
  // kind of typo nothing downstream would catch.
  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // clipboard is refused without a secure context or when the document is not focused, so
      // fall back to the selection trick, which only needs the click we are already inside.
      const ta = document.createElement("textarea");
      ta.value = id;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand("copy")) return;
      } catch {
        return;
      } finally {
        ta.remove();
      }
    }
    setCopied(id);
    clearTimeout(flash);
    flash = setTimeout(() => setCopied(null), 1000);
  }

  const statusOfSpawn = (s: Spawn) => statusOf(s, props.assign[s.id], props.paths[s.id]);

  const inScope = createMemo(() => props.spawns.filter(props.visible));

  const counts = createMemo(() => {
    const tally: Record<string, number> = { all: inScope().length, region: 0, route: 0, fixed: 0, nowhere: 0 };
    for (const s of inScope()) tally[statusOfSpawn(s)]++;
    return tally;
  });

  const shown = createMemo(() => {
    const needle = filter().toLowerCase();
    const want = status();
    return inScope().filter(s =>
      (want === "all" || statusOfSpawn(s) === want)
      && (!needle || s.name.toLowerCase().includes(needle) || s.id.includes(needle))
    );
  });

  const colorFor = (s: Spawn) => {
    const where = statusOfSpawn(s);
    if (where === "region") return props.colorOf(props.assign[s.id][0]);
    if (where === "route") return "#a78bfa";
    return where === "fixed" ? "#94a3b8" : "#f87171";
  };

  const label = (s: Spawn) => {
    const where = statusOfSpawn(s);
    if (where === "region") {
      const names = props.assign[s.id];
      // The whole list will not fit the column, and the count is the part worth noticing.
      return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
    }
    if (where === "route") return `${props.paths[s.id].legs.length} legs`;
    return where === "fixed" ? "fixed point" : "nowhere";
  };

  return (
    <div class="flex flex-col bg-slate-800 rounded-lg p-2 text-sm" style={{ width: open() ? "20rem" : "2.5rem" }}>
      <button
        class="w-full flex items-center justify-between text-slate-300 hover:text-white mb-2"
        title={open() ? "Hide the mob list" : "Show the mob list"}
        onClick={() => setOpen(o => !o)}
      >
        <span class="text-xs uppercase tracking-wide">{open() ? `Mobs (${inScope().length})` : ""}</span>
        <span>{open() ? "‹" : "›"}</span>
      </button>

      <Show when={open()}>
        <input
          type="text"
          placeholder="Filter (template or id)..."
          class="w-full px-2 py-1 mb-2 bg-slate-700 rounded text-xs"
          value={filter()}
          onInput={e => setFilter(e.currentTarget.value)}
        />
        <div class="flex flex-wrap gap-1 mb-2">
          <For each={FILTERS}>
            {f => (
              <button
                class="px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap"
                classList={{ "bg-slate-600 text-white": status() === f.key, "bg-slate-700 text-slate-400": status() !== f.key }}
                onClick={() => setStatus(f.key)}
              >
                {f.label} {counts()[f.key]}
              </button>
            )}
          </For>
        </div>

        {/* Only offered on the mobs it would act on, since it reads their trails to find the shape. */}
        <Show when={!props.readOnly && status() === "fixed" && shown().length}>
          <button
            class="w-full px-2 py-1 mb-2 bg-slate-600 hover:bg-slate-500 rounded text-xs disabled:opacity-40 disabled:text-slate-300"
            disabled={!props.canBuild}
            title="Rasterise these mobs' roam trails into a new region and assign them to it"
            onClick={() => props.onBuildRegion(shown())}
          >
            Build a region around these {shown().length}
          </button>
        </Show>

        <div class="flex-1 overflow-y-auto">
          <For each={shown()} fallback={<div class="text-slate-500 p-2 text-xs">Nothing matches.</div>}>
            {s => (
              <div
                class="flex items-center gap-1.5 py-0.5 px-1 rounded text-xs cursor-pointer hover:bg-slate-700"
                classList={{ "bg-slate-700": props.pinnedId === s.id }}
                title={`${s.name} ${s.id}${
                  props.samples(s.id) ? `, ${props.samples(s.id)} roam points` : ", no roam trail"
                }, click to keep its trail on screen, alt-click to copy its id, right-click for more`}
                onMouseEnter={() => props.onHover(s.id)}
                onMouseLeave={() => props.onHover(null)}
                onClick={e => (e.altKey ? copyId(s.id) : props.onPin(s.id))}
                onContextMenu={e => (e.preventDefault(), props.onMenu(s, e.clientX, e.clientY))}
              >
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  classList={{ "opacity-30": !props.samples(s.id) }}
                  style={{ "background-color": colorFor(s) }}
                />
                <span class="flex-1 truncate">{s.name}</span>
                <span class="truncate max-w-20" style={{ color: colorFor(s) }}>{label(s)}</span>
                {/* Dim, because it is here to be read off against the yaml rather than scanned. */}
                <span
                  class="tabular-nums"
                  classList={{ "text-slate-600": copied() !== s.id, "text-emerald-400": copied() === s.id }}
                >
                  {s.id}
                </span>
                <Show when={!props.readOnly && props.activeName && !props.assign[s.id]?.includes(props.activeName)}>
                  <button
                    class="px-1 leading-none text-slate-400 hover:text-white"
                    title={`Assign to ${props.activeName}, shift to add it to the ones it already has`}
                    onClick={e => (e.stopPropagation(), props.onAssign(s, e.shiftKey))}
                  >
                    +
                  </button>
                </Show>
                <Show when={s.at} fallback={<span class="px-1 leading-none text-slate-600" title="No position in mobs.yaml">·</span>}>
                  <button
                    class="px-1 leading-none text-slate-400 hover:text-white"
                    title="Centre on it"
                    onClick={e => (e.stopPropagation(), props.onCentre(s))}
                  >
                    ⌖
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
