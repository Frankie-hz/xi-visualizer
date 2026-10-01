import { For, Show } from "solid-js";
import type { Region, Spawn } from "../regions";
import { onActivate } from "../util";
import { BTN } from "./ui";

type Named = Region & { name: string; };

const TOOL = "px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded disabled:opacity-40 disabled:text-slate-300";
const CHIP = "px-1.5 py-0.5 rounded";
const chipOn = (on: boolean) => (on ? "bg-slate-600 text-white" : "bg-slate-700 text-slate-400");

/**
 * The Regions tab: the tools that make and change regions, the floor picker, every region on the
 * floor with its counts, and the selected region's mobs.
 */
export default function RegionsTab(props: {
  canEdit: boolean;
  drawing: boolean;
  /** The selected region's name. */
  selected: string | null;
  onAddRegion: () => void;
  onStartHole: () => void;
  onToggleDraw: () => void;
  /** Map sheets to choose between; one or none means the zone has no floors. */
  floors: number[];
  floor: number | null;
  onFloor: (floor: number | null) => void;
  hideAssigned: boolean;
  onHideAssigned: (hide: boolean) => void;
  /** Mobs with no region yet. */
  left: number;
  terrainColors: boolean;
  onTerrainColors: (on: boolean) => void;
  regions: Named[];
  colorOf: (name: string) => string;
  counts: Record<string, number>;
  /** Share of each region's mobs' roam points inside it, from the last Review check. */
  coverage: Record<string, number>;
  coverageStale: boolean;
  rowRef: (name: string, el: HTMLDivElement) => void;
  onSelect: (name: string) => void;
  onMenu: (name: string, x: number, y: number) => void;
  /** False when the new name is refused, so the field can snap back. */
  onRename: (from: string, to: string) => boolean;
  onCentre: (name: string) => void;
  onDelete: (name: string) => void;
  filter: string;
  onFilter: (text: string) => void;
  /** Mobs standing inside the selected region by their own spawn point and not yet in it: what Assign inside would take. */
  inside: number;
  onAssignInside: (remove: boolean) => void;
  canRefit: boolean;
  onRefit: () => void;
  members: Spawn[];
  pinnedId: string | null;
  onRowFocus: (id: string | null) => void;
  onPin: (id: string) => void;
  onFly: (spawn: Spawn) => void;
  onUnassign: (id: string) => void;
}) {
  const vertices = (r: Named) => r.rings[0]?.length ?? 0;
  const holes = (r: Named) => r.rings.length - 1;
  const filtered = () => (props.filter ? `, of those matching "${props.filter}"` : "");
  return (
    <>
      {/* The tools that change geometry, and only those: the list below is what a reviewer came to read. */}
      <Show when={props.canEdit}>
        <div class="flex gap-1 mb-2">
          <button class={`${TOOL} flex-1`} onClick={() => props.onAddRegion()}>+ Region</button>
          <button
            class={TOOL}
            disabled={!props.selected}
            onClick={() => props.onStartHole()}
            title="Cut a hole in the active region: click its corners on the map, Enter when done"
          >
            + Hole
          </button>
          <button
            class={props.drawing ? `${TOOL} bg-emerald-600 hover:bg-emerald-500` : TOOL}
            disabled={!props.selected}
            title={props.drawing ? "Stop adding vertices" : "Click on the map to add vertices to the outline, after its last one"}
            onClick={() => props.onToggleDraw()}
          >
            {props.drawing ? "Done" : "Draw"}
          </button>
        </div>
      </Show>

      {/* Only somewhere with floors to choose between: an outdoor zone is one map sheet. */}
      <Show when={props.floors.length > 1}>
        <div class="flex flex-wrap items-center gap-1 mb-2 text-xs">
          <span class="text-slate-400 mr-1">Floor</span>
          <button class={`${CHIP} ${chipOn(props.floor === null)}`} onClick={() => props.onFloor(null)}>All</button>
          <For each={props.floors}>
            {id => (
              <button
                class={`${CHIP} ${chipOn(props.floor === id)}`}
                title={`Show only map ${id}, hiding the floors above and below it`}
                onClick={() => props.onFloor(props.floor === id ? null : id)}
              >
                {id}
              </button>
            )}
          </For>
        </div>
      </Show>

      <label class="flex items-center gap-2 mb-1 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" checked={props.hideAssigned} onChange={e => props.onHideAssigned(e.currentTarget.checked)} />
        hide mobs that have a region ({props.left} left)
      </label>
      <label class="flex items-center gap-2 mb-2 text-xs text-slate-400 cursor-pointer">
        <input type="checkbox" checked={props.terrainColors} onChange={e => props.onTerrainColors(e.currentTarget.checked)} />
        terrain materials
      </label>

      <div class="flex-1 overflow-y-auto">
        <For each={props.regions} fallback={<div class="text-slate-500 p-2">No regions yet.</div>}>
          {r => (
            <div
              ref={el => props.rowRef(r.name, el)}
              class="flex items-center gap-2 py-1 px-1 rounded cursor-pointer hover:bg-slate-700"
              classList={{ "bg-slate-700": r.name === props.selected }}
              tabIndex={0}
              onKeyDown={onActivate(() => props.onSelect(r.name))}
              onClick={() => props.onSelect(r.name)}
              onContextMenu={e => (e.preventDefault(), props.onMenu(r.name, e.clientX, e.clientY))}
            >
              <span class="w-3 h-3 rounded-full shrink-0" style={{ background: props.colorOf(r.name) }} />
              <Show when={props.canEdit} fallback={<span class="flex-1 min-w-0 truncate px-1">{r.name}</span>}>
                <input
                  type="text"
                  class="flex-1 min-w-0 bg-transparent px-1 rounded outline-none hover:bg-slate-600 focus:bg-slate-900"
                  value={r.name}
                  title="Click to rename"
                  onClick={e => e.stopPropagation()}
                  onFocus={() => props.onSelect(r.name)}
                  onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                  onChange={e => {
                    if (!props.onRename(r.name, e.currentTarget.value)) e.currentTarget.value = r.name;
                  }}
                />
              </Show>
              <span
                class="text-xs text-slate-400"
                title={`${vertices(r)} vertices${holes(r) ? `, ${holes(r)} hole${holes(r) > 1 ? "s" : ""}` : ""}, ${
                  props.counts[r.name] ?? 0
                } mobs placed here`}
              >
                {vertices(r)}v{holes(r) ? `+${holes(r)}h` : ""} · {props.counts[r.name] ?? 0}
              </span>
              <Show when={props.coverage[r.name] !== undefined}>
                {/* From the last Review check, and dimmed once the regions have moved on from it. */}
                <span
                  class="text-xs"
                  style={{ opacity: props.coverageStale ? 0.45 : 1 }}
                  classList={{
                    "text-slate-500": props.coverage[r.name] >= 0.9,
                    "text-amber-400": props.coverage[r.name] < 0.9 && props.coverage[r.name] >= 0.7,
                    "text-red-400": props.coverage[r.name] < 0.7,
                  }}
                  title={`Share of its mobs' roam points inside this region${
                    props.coverageStale ? ", as of the last Review check; open Review to recount" : ""
                  }`}
                >
                  {(props.coverage[r.name] * 100).toFixed(0)}%
                </span>
              </Show>
              <button class={BTN.icon} title="Centre on it" aria-label="Centre on it" onClick={e => (e.stopPropagation(), props.onCentre(r.name))}>
                ⌖
              </button>
              <Show when={props.canEdit}>
                <button class={BTN.iconDanger} title="Delete region" aria-label="Delete region" onClick={e => (e.stopPropagation(), props.onDelete(r.name))}>
                  ✕
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>

      <Show when={props.selected}>
        {name => (
          <div class="border-t border-slate-700 mt-2 pt-2 space-y-2">
            <input
              type="text"
              placeholder="Filter mobs (name or id)…"
              class="w-full px-2 py-1 bg-slate-700 rounded"
              value={props.filter}
              onInput={e => props.onFilter(e.currentTarget.value)}
            />
            <Show when={props.canEdit}>
              <div class="flex gap-1 text-xs">
                <button
                  class={`${TOOL} flex-1`}
                  title={`Put every mob whose spawn point is inside ${name()} in it${filtered()}`}
                  onClick={() => props.onAssignInside(false)}
                >
                  Assign inside ({props.inside})
                </button>
                <button
                  class={`${TOOL} flex-1`}
                  title={`Take every mob whose spawn point is inside ${name()} out of its region${filtered()}`}
                  onClick={() => props.onAssignInside(true)}
                >
                  Unassign inside
                </button>
                <button
                  class={TOOL}
                  disabled={!props.canRefit}
                  title="Reshape this region around the roam trails of the mobs in it"
                  onClick={() => props.onRefit()}
                >
                  Refit
                </button>
              </div>
            </Show>

            <div class="text-xs text-slate-400">
              {props.counts[name()] ?? 0} assigned{props.filter && ` · ${props.members.length} shown`}
            </div>
            <div class="max-h-48 overflow-y-auto">
              <For each={props.members} fallback={<div class="text-xs text-slate-500 px-1">Nothing assigned yet.</div>}>
                {s => (
                  <div
                    class="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-slate-700 text-xs cursor-pointer"
                    classList={{ "bg-slate-600 hover:bg-slate-600": s.id === props.pinnedId }}
                    title="Click to keep this mob's roam trail on screen"
                    onMouseEnter={() => props.onRowFocus(s.id)}
                    onMouseLeave={() => props.onRowFocus(null)}
                    tabIndex={0}
                    onKeyDown={onActivate(() => props.onPin(s.id))}
                    onClick={() => props.onPin(s.id)}
                  >
                    <span class="flex-1 truncate" title={s.name}>{s.name}</span>
                    <span class="text-slate-500">{s.id}</span>
                    <Show when={s.at} fallback={<span class="px-1 text-slate-600" title="Placed by the region, no fixed point">·</span>}>
                      <button class={BTN.icon} title="Centre on it" aria-label="Centre on it" onClick={e => (e.stopPropagation(), props.onFly(s))}>
                        ⌖
                      </button>
                    </Show>
                    <Show when={props.canEdit}>
                      <button class={BTN.iconDanger} title="Unassign" aria-label="Unassign" onClick={e => (e.stopPropagation(), props.onUnassign(s.id))}>
                        ✕
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
