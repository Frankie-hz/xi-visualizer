import hljs from "highlight.js/lib/core";
import yaml from "highlight.js/lib/languages/yaml";
import { createMemo, createSignal, For, Show } from "solid-js";
import { copyText } from "../util";
import "highlight.js/styles/atom-one-dark.css";

hljs.registerLanguage("yaml", yaml);

const LINE = 18; // px, and the row height the stylesheet below is pinned to
const WINDOW = 400; // lines built at a time
const MARGIN = 60; // lines kept either side, so a flick of the wheel lands on something drawn

interface YamlViewProps {
  files: { name: string; text: string; }[];
  onClose: () => void;
}

/**
 * The files as they would be written, read-only. What ends up in the commit is the thing being
 * reviewed, and until now the only way to see it was to paste the clipboard somewhere else.
 *
 * Only the lines on screen are built. A zone's regions run to a quarter of a megabyte, and handing
 * that to the highlighter whole took five seconds and a hundred thousand nodes to show forty lines.
 */
export default function YamlView(props: YamlViewProps) {
  const [which, setWhich] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [copied, setCopied] = createSignal<boolean | undefined>();
  const copy = async () => {
    setCopied(await copyText(current()?.text ?? ""));
    setTimeout(() => setCopied(undefined), 1500);
  };

  const current = () => props.files[Math.min(which(), props.files.length - 1)];
  const lines = createMemo(() => current()?.text.split("\n") ?? []);

  const window = createMemo(() => {
    const first = Math.max(0, Math.floor(scroll() / LINE) - MARGIN);
    const visible = Math.ceil(height() / LINE) + MARGIN * 2;
    const last = Math.min(lines().length, first + Math.max(WINDOW, visible));
    // Highlighted as a block rather than line by line, so a comment or a string keeps its context.
    return { first, html: hljs.highlight(lines().slice(first, last).join("\n"), { language: "yaml" }).value };
  });

  return (
    <div class="flex flex-col bg-slate-800 rounded-lg" style={{ height: "78vh" }}>
      <div class="flex items-center gap-2 p-2 border-b border-slate-700 text-xs">
        <For each={props.files}>
          {(file, i) => (
            <button
              class="px-2 py-1 rounded"
              classList={{ "bg-slate-600 text-white": which() === i(), "bg-slate-700 text-slate-400": which() !== i() }}
              onClick={() => (setWhich(i()), setScroll(0))}
            >
              {file.name}
            </button>
          )}
        </For>
        <Show when={current()}>
          <span class="text-slate-500">
            {lines().length} lines · {(current()!.text.length / 1024).toFixed(0)} kB
          </span>
        </Show>
        <span class="flex-1" />
        <button
          class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
          onClick={copy}
        >
          {copied() === undefined ? "Copy" : copied() ? "Copied" : "Copy failed"}
        </button>
        <button class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200" onClick={props.onClose}>Close</button>
      </div>

      <div
        class="flex-1 overflow-auto font-mono text-xs"
        ref={el => queueMicrotask(() => setHeight(el.clientHeight))}
        onScroll={e => setScroll(e.currentTarget.scrollTop)}
      >
        {/* A spacer the height of the whole file, with the built lines parked at the right offset. */}
        <div style={{ height: `${lines().length * LINE}px`, position: "relative" }}>
          <div style={{ position: "absolute", top: `${window().first * LINE}px`, left: 0, right: 0 }}>
            {/* hljs escapes what it is given, so the markup it returns carries no yaml of its own. */}
            <pre class="m-0 p-0" style={{ "line-height": `${LINE}px` }}><code class="hljs bg-transparent p-0" innerHTML={window().html} /></pre>
          </div>
        </div>
      </div>
    </div>
  );
}
