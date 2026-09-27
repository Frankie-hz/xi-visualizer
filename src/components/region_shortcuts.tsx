import { createSignal, For, Show } from "solid-js";

// The chip is the input, the text says what it acts on — no glyph decoding required.
const SHORTCUTS: { title: string; keys: [string, string][]; }[] = [
  {
    title: "Polygon",
    keys: [
      ["click", "while drawing, add a vertex"],
      ["drag", "a corner to move that vertex"],
      ["drag", "a small square on an edge to add a vertex"],
      ["right-click", "a corner to remove that vertex"],
      ["enter / esc", "finish drawing"],
      ["click", "in Obstacles mode, ring the steep faces under the cursor with a hole at the margin"],
    ],
  },
  {
    title: "Route",
    keys: [
      ["right-click", "a mob or a region to make it a patrol"],
      ["click", "while drawing, add a leg"],
      ["drag", "a waypoint to move it"],
      ["enter", "finish drawing the legs"],
      ["esc", "leave the route · click off it does the same"],
    ],
  },
  {
    title: "Spawns",
    keys: [
      ["click", "a spawn dot to assign it to the selected region"],
      ["shift+click", "a dot, or + in the Mobs panel on the left, to add the region to the ones it already has"],
      ["drag", "a spawn dot into a polygon to assign it there"],
      ["hover", "a dot or a list row to show its roam trail"],
      ["right-click", "a mob to replay its trail and see which way it walks"],
      ["click", "a list row to keep that trail on screen"],
    ],
  },
  {
    title: "Map",
    keys: [
      ["alt+click", "copy !pos x y z"],
      ["drag", "pan · right-drag rotates · wheel zooms"],
      ["pgdn / pgup", "next / previous region, keeping the view angle, with its first mob held"],
      ["ctrl+z", "undo · ctrl+shift+z redoes"],
    ],
  },
];

/** The what-does-what card in the corner of the map, closed until asked for. */
export default function ShortcutsCard() {
  const [showKeys, setShowKeys] = createSignal(false);
  return (
    <div class="absolute top-2 right-2 flex flex-col items-end gap-1 text-xs">
      <button
        class="w-6 h-6 rounded bg-slate-900/80 text-slate-300 hover:text-white"
        title={showKeys() ? "Hide shortcuts" : "Show shortcuts"}
        onClick={() => setShowKeys(k => !k)}
      >
        {showKeys() ? "×" : "?"}
      </button>
      <Show when={showKeys()}>
        <div class="bg-slate-900/85 rounded px-3 py-2 space-y-2 pointer-events-none">
          <For each={SHORTCUTS}>
            {group => (
              <div class="space-y-1">
                <div class="text-[10px] uppercase tracking-wide text-slate-500">{group.title}</div>
                <For each={group.keys}>
                  {([key, what]) => (
                    <div class="flex items-center gap-2">
                      <kbd class="inline-block min-w-24 text-center bg-slate-700 border-b-2 border-slate-600 rounded px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
                        {key}
                      </kbd>
                      <span class="text-slate-300">{what}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
