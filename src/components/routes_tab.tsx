import { For, Show } from "solid-js";
import type { Patrol, Spawn } from "../regions";
import { onActivate } from "../util";
import { BTN } from "./ui";

/** The Routes tab: every mob that walks a route, with the route's own controls on its row. */
export default function RoutesTab(props: {
  paths: Record<string, Patrol>;
  spawns: Spawn[];
  /** The mob whose route is being edited. */
  walker: string | null;
  canEdit: boolean;
  rowRef: (id: string, el: HTMLDivElement) => void;
  onSelect: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onToggleLoop: (id: string) => void;
  onRetrace: (id: string) => void;
  onAddLegs: (id: string) => void;
  onDrop: (id: string) => void;
}) {
  /** A row's icon button, which must not also select the row under it. */
  const act = (fn: () => void) => (e: MouseEvent) => (e.stopPropagation(), fn());
  return (
    <>
      <div class="text-xs text-slate-400 mb-2">
        {/* What is being edited is on the banner over the map, where the editing happens. */}
        <Show when={!props.walker}>a route replaces a mob's spawn point, so it walks its legs instead</Show>
      </div>
      <div class="flex-1 overflow-y-auto">
        <For each={Object.entries(props.paths)} fallback={<div class="text-slate-500 p-2">No routes yet.</div>}>
          {([id, patrol]) => {
            const spawn = () => props.spawns.find(s => s.id === id);
            return (
              <div
                ref={el => props.rowRef(id, el)}
                class="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-slate-700 text-xs"
                classList={{ "bg-slate-700": id === props.walker }}
                onContextMenu={e => (e.preventDefault(), props.onMenu(id, e.clientX, e.clientY))}
                tabIndex={0}
                onKeyDown={onActivate(() => props.onSelect(id))}
                onClick={() => props.onSelect(id)}
              >
                <span class="flex-1 truncate" title={spawn()?.name}>{spawn()?.name ?? "unknown"}</span>
                <span class="text-slate-500">{id}</span>
                <span class="text-slate-400">{patrol.legs.length} legs</span>
                <Show when={props.canEdit}>
                  <button
                    class={BTN.icon}
                    title={patrol.loop === false ? "path: walks back along the same legs" : "circuit: closes into a loop"}
                    aria-label={patrol.loop === false ? "Walks back along the same legs; make it a loop" : "Loops; make it walk back along the same legs"}
                    onClick={act(() => props.onToggleLoop(id))}
                  >
                    {patrol.loop === false ? "↔" : "↻"}
                  </button>
                  <button
                    class={BTN.icon}
                    title="Re-trace from the mob's roam trail"
                    aria-label="Re-trace from the mob's roam trail"
                    onClick={act(() => props.onRetrace(id))}
                  >
                    ⟳
                  </button>
                  <button class={BTN.icon} title="Add more legs" aria-label="Add more legs" onClick={act(() => props.onAddLegs(id))}>
                    ✎
                  </button>
                  <button class={BTN.iconDanger} title="Remove the route" aria-label="Remove the route" onClick={act(() => props.onDrop(id))}>
                    ✕
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}
