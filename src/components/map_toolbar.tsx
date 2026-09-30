import type { JSX } from "solid-js";
import { GROUND_SNAP, SPIKE } from "../terrain";

const TOOL = "flex items-center gap-1.5 px-2 py-1 rounded disabled:opacity-40";
const IDLE = "bg-slate-900/80 hover:bg-slate-800 text-slate-200";
const PICK = "Select a region first";

function Icon(props: { children: JSX.Element; }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** The editor's map toolbar: tools that act on the selected region's shape. */
export default function MapToolbar(props: {
  selected: boolean;
  carving: boolean;
  /** The zone mesh is there to drop vertices onto. */
  canGround: boolean;
  onCarve: () => void;
  onSimplify: () => void;
  onGround: () => void;
}) {
  return (
    <div class="absolute top-2 left-2 flex gap-1 text-xs">
      <button
        class={`${TOOL} ${props.carving ? "bg-amber-600 hover:bg-amber-500 text-white" : IDLE}`}
        aria-pressed={props.carving}
        disabled={!props.selected}
        title={props.selected ? "Carve holes around the collision obstacles in the selected region: trees, rocks, walls" : PICK}
        onClick={() => props.onCarve()}
      >
        <Icon>
          <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
        </Icon>
        Carve holes
      </button>
      <button
        class={`${TOOL} ${IDLE}`}
        disabled={!props.selected}
        title={props.selected ? "Drop the least important quarter of the selected region's vertices" : PICK}
        onClick={() => props.onSimplify()}
      >
        <Icon>
          <path d="M2 12l3-6 3 4 2-3 4 5" />
          <path d="M2 12h12" stroke-dasharray="2 1.5" />
        </Icon>
        Simplify
      </button>
      <button
        class={`${TOOL} ${IDLE}`}
        disabled={!props.selected || !props.canGround}
        title={props.selected
          ? `Put every vertex of the selected region on the ground: onto a surface within ${GROUND_SNAP} yalms, and none more than ${SPIKE} yalms above or below both its neighbours`
          : PICK}
        onClick={() => props.onGround()}
      >
        <Icon>
          <path d="M8 2v8" />
          <path d="M5 7l3 3 3-3" />
          <path d="M2 13h12" />
        </Icon>
        Ground
      </button>
    </div>
  );
}
