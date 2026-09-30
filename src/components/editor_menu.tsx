import { type JSX, Show } from "solid-js";
import type { Spawn } from "../regions";

/** What was right-clicked, and where: the menu opens at the cursor. */
export type MenuTarget =
  & { x: number; y: number; }
  & (
    | { kind: "region"; name: string; }
    | { kind: "hole"; name: string; index: number; }
    | { kind: "ground"; name: string; x0: number; z0: number; }
    | { kind: "spawn"; spawn: Spawn; }
    | { kind: "route"; lead: string; }
  );

/** Everything the menu reads or does, supplied by the editor. Every entry closes the menu after. */
export interface MenuActions {
  canEdit: () => boolean;
  close: () => void;
  mobsIn: (region: string) => number;
  toRoute: (region: string) => void;
  repair: (region: string) => void;
  centre: (region: string) => void;
  deleteRegion: (region: string) => void;
  holeArea: (region: string, index: number) => number;
  nearHoles: (region: string, index: number) => number;
  mergeReach: () => number;
  merge: (region: string, index: number) => void;
  grow: (region: string, index: number) => void;
  deleteHole: (region: string, index: number) => void;
  holeFromRoam: (region: string, x: number, z: number) => void;
  traceRoute: (spawn: Spawn) => void;
  replaying: (id: string) => boolean;
  toggleReplay: (id: string) => void;
  /** The region an Assign entry would put a mob in: the selected one. */
  assignTarget: () => string | null;
  assign: (spawn: Spawn) => void;
  flyTo: (spawn: Spawn) => void;
  group: (lead: string) => { lead: string; ids: string[]; } | undefined;
  nameOf: (id: string) => string;
  editLegs: (lead: string) => void;
  retrace: (lead: string) => void;
  dropRoute: (ids: string[]) => void;
}

/** One entry in the menu. `danger` for the ones that delete something. */
function MenuItem(props: { danger?: boolean; title?: string; onClick: () => void; children: JSX.Element; }) {
  return (
    <button
      role="menuitem"
      class="block w-full text-left px-3 py-1 hover:bg-slate-700 focus:bg-slate-700 outline-none"
      classList={{ "text-red-400": props.danger }}
      title={props.title}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

const Heading = (props: { children: JSX.Element; }) => <div class="px-3 py-1 text-slate-500">{props.children}</div>;

/** The map's right-click menu, for a region, a hole, a spot inside the region, a mob or a route. */
export default function EditorMenu(props: { target: MenuTarget; ref: (el: HTMLDivElement) => void; actions: MenuActions; }) {
  const a = () => props.actions;
  /** Runs an entry and closes the menu, whichever the entry is. */
  const run = (fn: () => void) => () => (fn(), a().close());
  const as = <K extends MenuTarget["kind"]>(kind: K) => (props.target.kind === kind ? (props.target as Extract<MenuTarget, { kind: K; }>) : null);
  return (
    <div
      ref={props.ref}
      role="menu"
      class="fixed z-[100] min-w-44 bg-slate-900 border border-slate-600 rounded shadow-lg py-1 text-xs"
      style={{ left: `${props.target.x}px`, top: `${props.target.y}px` }}
    >
      <Show when={as("region")?.name}>
        {name => (
          <>
            <Heading>{name()}</Heading>
            <Show when={a().canEdit()}>
              <MenuItem onClick={run(() => a().toRoute(name()))}>
                Turn into a route ({a().mobsIn(name())} mob{a().mobsIn(name()) === 1 ? "" : "s"})
              </MenuItem>
              <MenuItem onClick={run(() => a().repair(name()))}>Repair the shape</MenuItem>
            </Show>
            <MenuItem onClick={run(() => a().centre(name()))}>Centre on it</MenuItem>
            <Show when={a().canEdit()}>
              <MenuItem danger onClick={run(() => a().deleteRegion(name()))}>Delete region</MenuItem>
            </Show>
          </>
        )}
      </Show>
      <Show when={as("hole")}>
        {hole => (
          <>
            <Heading>
              {hole().name} · hole {hole().index} · {a().holeArea(hole().name, hole().index).toFixed(0)} y²
            </Heading>
            <MenuItem onClick={run(() => a().merge(hole().name, hole().index))}>
              Merge nearby holes… ({a().nearHoles(hole().name, hole().index)} within {a().mergeReach()}y)
            </MenuItem>
            <MenuItem
              title="Grow this hole over the ground around it that no member mob was recorded on"
              onClick={run(() => a().grow(hole().name, hole().index))}
            >
              Grow to roam data…
            </MenuItem>
            <MenuItem danger onClick={run(() => a().deleteHole(hole().name, hole().index))}>Delete hole</MenuItem>
          </>
        )}
      </Show>
      <Show when={as("ground")}>
        {spot => (
          <>
            <Heading>
              {spot().name} · {spot().x0.toFixed(1)}, {spot().z0.toFixed(1)}
            </Heading>
            <MenuItem
              title="Cut a hole over the ground around this spot that no member mob was recorded on"
              onClick={run(() => a().holeFromRoam(spot().name, spot().x0, spot().z0))}
            >
              Hole from roam data…
            </MenuItem>
          </>
        )}
      </Show>
      <Show when={as("spawn")?.spawn}>
        {spawn => (
          <>
            <Heading>
              {spawn().name} {spawn().id}
            </Heading>
            <Show when={a().canEdit()}>
              <MenuItem onClick={run(() => a().traceRoute(spawn()))}>Trace a route</MenuItem>
            </Show>
            <MenuItem onClick={run(() => a().toggleReplay(spawn().id))}>{a().replaying(spawn().id) ? "Stop the replay" : "Replay its trail"}</MenuItem>
            <Show when={a().canEdit() && a().assignTarget()}>
              {target => <MenuItem onClick={run(() => a().assign(spawn()))}>Assign to {target()}</MenuItem>}
            </Show>
            <MenuItem onClick={run(() => a().flyTo(spawn()))}>Centre on it</MenuItem>
          </>
        )}
      </Show>
      <Show when={as("route") && a().group(as("route")!.lead)}>
        {group => (
          <>
            <Heading>
              {a().nameOf(group().lead)}
              {group().ids.length > 1 ? ` and ${group().ids.length - 1} more` : ""}
            </Heading>
            <Show when={a().canEdit()}>
              <MenuItem onClick={run(() => a().editLegs(group().lead))}>Edit the legs</MenuItem>
              <MenuItem onClick={run(() => a().retrace(group().lead))}>Re-trace from the roam trail</MenuItem>
            </Show>
            <MenuItem onClick={run(() => a().toggleReplay(group().lead))}>
              {a().replaying(group().lead) ? "Stop the replay" : "Replay the trail it came from"}
            </MenuItem>
            <Show when={a().canEdit()}>
              {/* The ids are read before dropping: the group is gone the moment its routes are. */}
              <MenuItem danger onClick={run(() => a().dropRoute([...group().ids]))}>Drop the route</MenuItem>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
