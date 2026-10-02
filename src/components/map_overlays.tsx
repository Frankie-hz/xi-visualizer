import type { JSX } from "solid-js";
import type * as THREE from "three";

/** A zone position as !pos takes it. */
export const xyz = (p: THREE.Vector3) => [p.x, p.y, p.z].map(n => n.toFixed(3)).join(" ");

/** The ground position under the cursor, in the map's corner, with the in-game grid square when the
 * zone has a map there. Not clickable: reaching it moves the cursor off the spot it shows, so
 * alt+click on the map is what copies a position. */
export function CursorReadout(props: { at: THREE.Vector3; grid?: string | null; /** Above the grid's header strip. */ raised?: boolean; }) {
  return (
    <div
      class="absolute left-2 font-mono text-xs text-slate-200 bg-slate-900/75 rounded px-2 py-1 pointer-events-none select-none"
      classList={{ "bottom-2": !props.raised, "bottom-8": props.raised }}
    >
      {props.grid && <span class="text-amber-300 mr-2">({props.grid})</span>}
      {xyz(props.at)}
      <span class="text-slate-500 ml-2">alt+click copies !pos</span>
    </div>
  );
}

/** A note that follows the cursor, below and right of it, and never takes a click. */
export function CursorTooltip(props: { x: number; y: number; children: JSX.Element; }) {
  return (
    <div
      class="fixed bg-slate-900/90 text-white px-2 py-1 rounded text-xs pointer-events-none z-50"
      style={{ left: `${props.x + 12}px`, top: `${props.y + 12}px` }}
    >
      {props.children}
    </div>
  );
}
