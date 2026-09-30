export interface DialSpec {
  label: string;
  unit: string;
  get: () => number;
  set: (value: number) => void;
  min: number;
  max: number;
  step: number;
  title: string;
  advanced?: boolean;
}

/** One labelled slider, with its value and unit beside it. */
export default function Dial(props: DialSpec) {
  return (
    <label class="flex items-center gap-2" title={props.title}>
      <span class="w-24 shrink-0 whitespace-nowrap text-slate-300">{props.label}</span>
      <input
        type="range"
        class="flex-1 min-w-0"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.get()}
        aria-label={props.label}
        onInput={e => props.set(Number(e.currentTarget.value))}
      />
      <span class="w-14 shrink-0 text-right font-mono text-slate-200">{props.get()}{props.unit}</span>
    </label>
  );
}
