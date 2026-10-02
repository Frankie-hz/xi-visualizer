import { For, type JSX, Show } from "solid-js";
import { changeCount } from "../comparison";
import { css } from "../theme";
import { type CompareFocus, type CompareSides, STATUS_COLOR } from "./compare_overlay";

/** "area +12%", or what a region with no area before it actually is. */
const areaChange = (ratio: number) => Number.isFinite(ratio) ? `area ${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(0)}%` : "had no area before";
const holeChange = (from: number, to: number) => {
  const n = Math.abs(to - from);
  return `${to > from ? "+" : "−"}${n} hole${n === 1 ? "" : "s"}`;
};
const swatch = (kind: keyof typeof STATUS_COLOR) => css(STATUS_COLOR[kind]);
/** A move names its regions joined with ", ": a mob given several is in each of them. */
const names = (joined?: string) => joined?.split(", ") ?? [];

/** Everything the list offers to pick, in the order it lists it, for stepping through with j and k. */
export const changeList = (sides: CompareSides): CompareFocus[] => {
  const d = sides.diff;
  return [
    ...[...d.added, ...d.removed, ...d.reshaped.map(c => c.name)].map(name => ({ name })),
    ...[...d.moved, ...d.rerouted, ...d.relocated].map(m => ({ spawn: m.id })),
  ];
};

/** What a comparison changed in the zone on screen, and what the picked change amounts to. */
export default function ChangesTab(props: {
  sides: CompareSides;
  focus?: CompareFocus;
  onFocus: (focus: CompareFocus) => void;
  /** Whether a spawn has a recorded roam trail, to say so when it has none. */
  hasTrail: (id: string) => boolean;
}) {
  const d = () => props.sides.diff;
  const picked = () => props.focus?.name;
  const pickedKind = (): keyof typeof STATUS_COLOR => {
    const name = picked();
    if (!name) return "unchanged";
    if (d().added.includes(name)) return "added";
    if (d().removed.includes(name)) return "removed";
    return d().reshaped.some(c => c.name === name) ? "reshaped" : "unchanged";
  };
  const pickedChange = () => d().reshaped.find(c => c.name === picked());
  const held = (side: "base" | "head") => props.sides[side].spawns.filter(sp => sp.regions?.includes(picked()!)).length;
  const movedIn = () => d().moved.filter(m => names(m.to).includes(picked()!));
  const movedOut = () => d().moved.filter(m => names(m.from).includes(picked()!));
  const wentTo = () => [...new Set(movedOut().map(m => m.to ?? "no region"))];
  const vertices = () => props.sides[pickedKind() === "removed" ? "base" : "head"].regions[picked() ?? ""]?.rings[0]?.length ?? 0;
  const pickedMove = () => d().moved.find(m => m.id === props.focus?.spawn);

  return (
    <div class="flex flex-col gap-1 text-sm">
      <div class="text-[10px] text-slate-500 px-1">
        <kbd>j</kbd>/<kbd>k</kbd> next or previous change · <kbd>[</kbd>/<kbd>]</kbd> zone · <kbd>esc</kbd> whole zone
      </div>

      {/* What the picked change amounts to: how many mobs it places and where any of them went. */}
      <Show when={picked()}>
        <div class="bg-slate-900/70 rounded px-2 py-1.5">
          <div class="flex items-baseline gap-2">
            <b style={{ color: swatch(pickedKind()) }}>{picked()}</b>
            <span class="text-slate-400">{pickedKind()}</span>
          </div>
          <div class="text-slate-300 text-xs mt-0.5">
            <Show when={pickedChange()} fallback={<>{vertices()} vertices</>}>
              <Show when={pickedChange()!.fromVertices !== pickedChange()!.toVertices} fallback={<>outline unchanged</>}>
                {pickedChange()!.fromVertices} → {pickedChange()!.toVertices} vertices
              </Show>
              <Show when={Math.abs(pickedChange()!.areaRatio - 1) > 0.005}>{" · "}{areaChange(pickedChange()!.areaRatio)}</Show>
              <Show when={pickedChange()!.toHoles !== pickedChange()!.fromHoles}>
                {" · "}
                <span class="text-amber-300">{holeChange(pickedChange()!.fromHoles, pickedChange()!.toHoles)}</span>
              </Show>
            </Show>
          </div>
          <div class="mt-1 text-slate-200 text-xs">
            <Show
              when={pickedKind() !== "removed"}
              fallback={
                <>
                  held <b>{held("base")}</b> mob{held("base") === 1 ? "" : "s"}
                  <Show when={wentTo().length}>
                    <span class="text-slate-400">, now in</span> <span style={{ color: swatch("added") }}>{wentTo().join(", ")}</span>
                  </Show>
                </>
              }
            >
              <b>{held("head")}</b> mob{held("head") === 1 ? "" : "s"} placed here
              <Show when={movedIn().length || movedOut().length}>
                <span class="text-slate-400">
                  {" ("}
                  <Show when={movedIn().length}>
                    <span style={{ color: swatch("added") }}>+{movedIn().length} in</span>
                  </Show>
                  <Show when={movedIn().length && movedOut().length}>{", "}</Show>
                  <Show when={movedOut().length}>
                    <span style={{ color: swatch("removed") }}>−{movedOut().length} out</span>
                  </Show>
                  {")"}
                </span>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={pickedMove()}>
        {m => (
          <div class="bg-slate-900/70 rounded px-2 py-1.5 text-xs">
            <span class="text-slate-300">{m().name}</span> <span class="text-slate-500">{m().id}</span>
            <div class="mt-0.5">
              <span style={{ color: swatch("removed") }}>{m().from ?? "no region"}</span> <span class="text-slate-400">→</span>{" "}
              <span style={{ color: swatch("added") }}>{m().to ?? "no region"}</span>
            </div>
            <Show when={!props.hasTrail(m().id)}>
              <div class="text-slate-500">no roam trail recorded for it</div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={changeCount(d()) === 0}>
        <div class="text-emerald-500 p-2">No region or spawn placement changed in this zone.</div>
      </Show>
      <For each={d().added}>
        {name => (
          <Row color={swatch("added")} mark="+" active={picked() === name} onClick={() => props.onFocus({ name })}>
            <b>{name}</b> added, {props.sides.head.regions[name].rings[0]?.length ?? 0} vertices,{" "}
            {props.sides.head.spawns.filter(s => s.regions?.includes(name)).length} spawns
          </Row>
        )}
      </For>
      <For each={d().removed}>
        {name => (
          <Row color={swatch("removed")} mark="−" active={picked() === name} onClick={() => props.onFocus({ name })}>
            <b>{name}</b> removed, held {props.sides.base.spawns.filter(s => s.regions?.includes(name)).length} spawns
          </Row>
        )}
      </For>
      <For each={d().reshaped}>
        {change => (
          <Row color={swatch("reshaped")} mark="~" active={picked() === change.name} onClick={() => props.onFocus({ name: change.name })}>
            <b>{change.name}</b>{" "}
            <Show when={change.fromVertices !== change.toVertices || Math.abs(change.areaRatio - 1) > 0.005} fallback={<>outline unchanged</>}>
              reshaped, {change.fromVertices} → {change.toVertices} vertices, {areaChange(change.areaRatio)}
            </Show>
            <Show when={change.toHoles !== change.fromHoles}>
              <span class="text-amber-300">, {holeChange(change.fromHoles, change.toHoles)}</span>
            </Show>
          </Row>
        )}
      </For>
      <Section title={`${d().moved.length} spawns reassigned`} when={d().moved.length}>
        <For each={d().moved}>
          {move => (
            <Row color={swatch("reshaped")} mark="→" active={props.focus?.spawn === move.id} onClick={() => props.onFocus({ spawn: move.id })}>
              <span class="text-slate-300">{move.name}</span> <span class="text-slate-500">{move.id}</span> {move.from ?? "no region"} →{" "}
              {move.to ?? "no region"}
            </Row>
          )}
        </For>
      </Section>
      <Section title={`${d().rerouted.length} routes changed`} when={d().rerouted.length}>
        <For each={d().rerouted}>
          {r => (
            <Row color={swatch("reshaped")} mark="↻" active={props.focus?.spawn === r.id} onClick={() => props.onFocus({ spawn: r.id })}>
              <span class="text-slate-300">{r.name}</span> <span class="text-slate-500">{r.id}</span>{" "}
              {r.fromLegs ? (r.toLegs ? `${r.fromLegs} → ${r.toLegs} legs` : "route removed") : `given a ${r.toLegs} leg route`}
            </Row>
          )}
        </For>
      </Section>
      <Section title={`${d().relocated.length} fixed points moved`} when={d().relocated.length}>
        <For each={d().relocated}>
          {r => (
            <Row color={swatch("reshaped")} mark="~" active={props.focus?.spawn === r.id} onClick={() => props.onFocus({ spawn: r.id })}>
              <span class="text-slate-300">{r.name}</span> <span class="text-slate-500">{r.id}</span>
            </Row>
          )}
        </For>
      </Section>
      <Section title="spawns in mobs.yaml" when={d().addedSpawns.length || d().removedSpawns.length}>
        <For each={d().addedSpawns}>
          {id => (
            <Row color={swatch("added")} mark="+">
              <span class="text-slate-300">{props.sides.head.spawns.find(s => s.id === id)?.name ?? id}</span> <span class="text-slate-500">{id}</span> added
            </Row>
          )}
        </For>
        <For each={d().removedSpawns}>
          {id => (
            <Row color={swatch("removed")} mark="−">
              <span class="text-slate-300">{props.sides.base.spawns.find(s => s.id === id)?.name ?? id}</span> <span class="text-slate-500">{id}</span> removed
            </Row>
          )}
        </For>
      </Section>
    </div>
  );
}

function Section(props: { title: string; when: unknown; children: JSX.Element; }) {
  return (
    <Show when={props.when}>
      <div class="text-xs uppercase tracking-wide text-slate-500 mt-2 px-1">{props.title}</div>
      {props.children}
    </Show>
  );
}

function Row(props: { color: string; mark: string; active?: boolean; onClick?: () => void; children: JSX.Element; }) {
  return (
    <div
      class="flex gap-2 py-0.5 px-1 rounded text-xs"
      classList={{ "bg-slate-700": props.active, "hover:bg-slate-700 cursor-pointer": !!props.onClick }}
      onClick={() => props.onClick?.()}
    >
      <span style={{ color: props.color }}>{props.mark}</span>
      <span class="text-slate-300">{props.children}</span>
    </div>
  );
}
