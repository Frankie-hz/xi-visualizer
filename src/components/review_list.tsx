import { For, Show } from "solid-js";
import type { Finding } from "../regions";
import { onActivate } from "../util";

/** The Review tab: what is wrong with the zone, each finding a link to where it is. */
export default function ReviewList(props: { findings: Finding[]; onJump: (f: Finding) => void; onRepair?: (region: string) => void; }) {
  const color = { error: "text-red-400", warn: "text-amber-400", info: "text-slate-400" };
  return (
    <div class="flex-1 overflow-y-auto">
      <For each={props.findings} fallback={<div class="text-emerald-500 p-2">Nothing to flag.</div>}>
        {f => (
          <div
            class="flex items-center gap-1 py-1 px-1 rounded hover:bg-slate-700 cursor-pointer text-xs"
            tabIndex={0}
            onKeyDown={onActivate(() => props.onJump(f))}
            onClick={() => props.onJump(f)}
          >
            <span class={color[f.level]}>●</span>
            <span class="flex-1 text-slate-300">
              {f.text}
              <Show when={f.region && !f.spawnId}>
                <span class="text-slate-500">{" "}in {f.region}</span>
              </Show>
            </span>
            {/* A crossing ring is the one finding here with a mechanical answer. */}
            <Show when={props.onRepair && f.region && f.code === "self-intersects"}>
              <button
                class="px-1.5 rounded bg-slate-600 hover:bg-slate-500 text-slate-100"
                title="Rebuild it as valid shapes"
                onClick={e => (e.stopPropagation(), props.onRepair?.(f.region!))}
              >
                Repair
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
