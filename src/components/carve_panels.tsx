import { For, Show } from "solid-js";
import Dial, { type DialSpec } from "./dial";

const PANEL = "absolute top-10 right-2 z-30 w-72 text-xs bg-slate-900/90 rounded px-3 py-2 space-y-2";
const HEADING = "text-[10px] uppercase tracking-wide text-slate-500";
const SECTION = "border-t border-slate-700 pt-1 text-[10px] uppercase tracking-wide text-slate-500";

/** A two-step hole edit, grow or merge: one dial, a preview on the map, then Apply or Cancel. */
export function PlanPanel(props: {
  title: string;
  status: string;
  dial: DialSpec;
  applyLabel: string;
  canApply: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div class={PANEL}>
      <div class="flex items-center justify-between">
        <span class={HEADING}>{props.title}</span>
        <span class="text-slate-400">{props.status} · esc cancels</span>
      </div>
      <Dial {...props.dial} />
      <div class="flex gap-1">
        <button
          class="flex-1 px-2 py-1 bg-violet-700 hover:bg-violet-600 rounded disabled:opacity-40"
          disabled={!props.canApply}
          onClick={() => props.onApply()}
        >
          {props.applyLabel}
        </button>
        <button class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded" onClick={() => props.onCancel()}>Cancel</button>
      </div>
    </div>
  );
}

/** The Carve holes tool's panel: what it found, the dials that decide it, and cutting it all. */
export function CarvePanel(props: {
  /** Obstacle dials; the `advanced` ones fold away under More dials. */
  dials: DialSpec[];
  clearance: DialSpec;
  patchAtLeast: DialSpec;
  obstacles: number;
  /** How many of the obstacles Ring all takes; the rest are cliffs or too big, and wait for a click. */
  ringAll: number;
  patches: number;
  /** Why no empty patches can be found, when none could be. */
  patchesWhyNot?: string;
  cutting: boolean;
  onRingAll: () => void;
  onCutPatches: () => void;
  onDefaults: () => void;
}) {
  return (
    <div class={PANEL}>
      <div class="flex items-center justify-between">
        <span class={HEADING}>Carve holes</span>
        <span class="text-slate-500">esc leaves</span>
      </div>
      <p class="text-slate-400 leading-snug">
        Cut holes where mobs cannot stand. Amber outlines are obstacles in the collision mesh, violet ones ground no mob was recorded on: click one to cut it,
        or cut them all below. Distances are in yalms.
      </p>
      <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
        <span class="flex items-center gap-1">
          <span class="w-4 border-t-2 border-amber-400" />Ring all cuts it
        </span>
        <span class="flex items-center gap-1">
          <span class="w-4 border-t-2 border-dashed border-amber-400" />too big, click it
        </span>
        <span class="flex items-center gap-1">
          <span class="w-4 border-t-2 border-dashed border-violet-400" />empty patch
        </span>
        <span class="flex items-center gap-1">
          <span class="w-4 border-t-2 border-white" />under the cursor
        </span>
      </div>
      <div class={SECTION}>
        Obstacles · {props.obstacles} found
        <Show when={props.obstacles - props.ringAll}>, {props.obstacles - props.ringAll} left to a click</Show>
      </div>
      <For each={props.dials.filter(d => !d.advanced)}>{d => <Dial {...d} />}</For>
      <details>
        <summary class="cursor-pointer text-slate-400 hover:text-slate-200">More dials</summary>
        <div class="space-y-2 mt-2">
          <For each={props.dials.filter(d => d.advanced)}>{d => <Dial {...d} />}</For>
        </div>
      </details>
      <div class={SECTION}>
        Empty patches · <Show when={props.patchesWhyNot} fallback={<>{props.patches} found</>}>{props.patchesWhyNot}</Show>
      </div>
      <Dial {...props.clearance} />
      <Dial {...props.patchAtLeast} />
      <div class="flex gap-1">
        <button
          class="flex-1 px-2 py-1 bg-amber-700 hover:bg-amber-600 rounded disabled:opacity-40"
          disabled={!props.ringAll || props.cutting}
          title="Ring every obstacle up to the size above; each one goes through the clipper on its own"
          onClick={() => props.onRingAll()}
        >
          Ring all ({props.ringAll})
        </button>
        <button
          class="flex-1 px-2 py-1 bg-violet-700 hover:bg-violet-600 rounded disabled:opacity-40"
          disabled={!props.patches || props.cutting}
          title="Cut every empty patch as a hole"
          onClick={() => props.onCutPatches()}
        >
          Cut patches ({props.patches})
        </button>
        <button class="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded" title="Put every dial back to its default" onClick={() => props.onDefaults()}>
          Defaults
        </button>
      </div>
    </div>
  );
}
