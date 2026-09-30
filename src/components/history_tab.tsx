import { For } from "solid-js";
import { onActivate } from "../util";
import type { Step } from "./history";
import { BTN } from "./ui";

/** The History tab: every step, newest first; clicking one takes the zone back to just before it. */
export default function HistoryTab(props: {
  undoStack: Step<unknown>[];
  redoStack: Step<unknown>[];
  onUndo: () => void;
  onRedo: () => void;
  onRewind: (index: number) => void;
}) {
  return (
    <>
      <div class="flex gap-2 mb-2">
        <button class={`${BTN.plain} flex-1`} disabled={!props.undoStack.length} onClick={() => props.onUndo()}>
          Undo
        </button>
        <button class={`${BTN.plain} flex-1`} disabled={!props.redoStack.length} onClick={() => props.onRedo()}>
          Redo
        </button>
      </div>
      <div class="flex-1 overflow-y-auto text-xs">
        <For each={[...props.redoStack].reverse()}>
          {step => <div class="py-0.5 px-1 text-slate-600 italic">{step.label}</div>}
        </For>
        <For each={[...props.undoStack].reverse()} fallback={<div class="text-slate-500 p-2">Nothing changed yet.</div>}>
          {(step, i) => (
            <div
              class="py-0.5 px-1 rounded cursor-pointer hover:bg-slate-700 text-slate-300"
              title="Take the zone back to just before this"
              tabIndex={0}
              onKeyDown={onActivate(() => props.onRewind(props.undoStack.length - 1 - i()))}
              onClick={() => props.onRewind(props.undoStack.length - 1 - i())}
            >
              {step.label}
            </div>
          )}
        </For>
      </div>
    </>
  );
}
