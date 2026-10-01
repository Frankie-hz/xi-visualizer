import { Show } from "solid-js";
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
  simulating: boolean;
  onSimulate: () => void;
  /** Reviewing: the tools that change shapes go, the spawn simulation stays. */
  readOnly?: boolean;
  grid: boolean;
  onGrid: () => void;
  zoneInfo: boolean;
  /** What showing the zone info would show, for its tooltip. */
  zoneInfoNote: string;
  onZoneInfo: () => void;
}) {
  return (
    <div class="absolute top-2 left-2 flex gap-1 text-xs">
      <Show when={!props.readOnly}>
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
      </Show>
      <button
        class={`${TOOL} ${props.simulating ? "bg-emerald-600 hover:bg-emerald-500 text-white" : IDLE}`}
        aria-pressed={props.simulating}
        disabled={!props.selected}
        title={props.selected ? "Show where the server would spawn mobs in the selected region, checked against its navmesh" : PICK}
        onClick={() => props.onSimulate()}
      >
        <Icon>
          <circle cx="4" cy="5" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="10" cy="4" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="7" cy="9" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="11" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </Icon>
        Spawns
      </button>
      <button
        class={`${TOOL} ${props.grid ? "bg-amber-600 hover:bg-amber-500 text-white" : IDLE}`}
        aria-pressed={props.grid}
        title="The game's map grid, A to O and 1 to 15, as <pos> reads it, for the floor on screen"
        onClick={() => props.onGrid()}
      >
        <Icon>
          <path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12" />
        </Icon>
        Grid
      </button>
      <button
        class={`${TOOL} ${props.zoneInfo ? "bg-pink-600 hover:bg-pink-500 text-white" : IDLE}`}
        aria-pressed={props.zoneInfo}
        title={`The zone's trigger areas (pink) and zone lines, where they start (cyan) and where those from other zones land (green). ${props.zoneInfoNote}`}
        onClick={() => props.onZoneInfo()}
      >
        <Icon>
          <rect x="2.5" y="4" width="7" height="7" />
          <path d="M11 7.5h3M12.5 6l1.5 1.5-1.5 1.5" />
        </Icon>
        Zone info
      </button>
    </div>
  );
}
