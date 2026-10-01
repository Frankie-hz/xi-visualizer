import type { JSX } from "solid-js";
import type * as THREE from "three";

/** A zone position as !pos takes it. */
export const xyz = (p: THREE.Vector3) => [p.x, p.y, p.z].map(n => n.toFixed(3)).join(" ");

/** The ground position under the cursor, in the map's corner, with the in-game grid square when the
 * zone has a map there; clicking copies the position. */
export function CursorReadout(props: { at: THREE.Vector3; grid?: string | null; onCopy: (text: string) => void; }) {
  return (
    <div
      class="absolute bottom-2 left-2 font-mono text-xs text-slate-200 bg-slate-900/75 rounded px-2 py-1 cursor-pointer select-none"
      title="Ground position under the cursor, and the grid square <pos> would give. Click to copy, or alt+click the map for !pos"
      onClick={() => props.onCopy(xyz(props.at))}
    >
      {props.grid && <span class="text-amber-300 mr-2">({props.grid})</span>}
      {xyz(props.at)}
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
