import { createSignal } from "solid-js";

export interface Step<S> {
  /** What the step is called in the history list: the change, not the click. */
  label: string;
  /** The state as it was before this step, which is what undoing it goes back to. */
  before: S;
}

/**
 * Undo and redo over whatever `snap` captures and `restore` puts back. A step is recorded before a
 * change, at the boundary of an operation, so a whole drag is one step however many moves it took.
 */
export function createHistory<S>(snap: () => S, restore: (s: S) => void, limit = 100) {
  const [undoStack, setUndoStack] = createSignal<Step<S>[]>([]);
  const [redoStack, setRedoStack] = createSignal<Step<S>[]>([]);

  const checkpoint = (label: string) => {
    setUndoStack(steps => [...steps, { label, before: snap() }].slice(-limit));
    setRedoStack([]);
  };

  /** Returns what was undone, so it can be said: an undo of an assignment changes nothing in view. */
  const undo = (): string | undefined => {
    const steps = undoStack();
    const step = steps[steps.length - 1];
    if (!step) return;
    setUndoStack(steps.slice(0, -1));
    setRedoStack(r => [...r, { label: step.label, before: snap() }]);
    restore(step.before);
    return step.label;
  };

  const redo = (): string | undefined => {
    const steps = redoStack();
    const step = steps[steps.length - 1];
    if (!step) return;
    setRedoStack(steps.slice(0, -1));
    setUndoStack(u => [...u, { label: step.label, before: snap() }]);
    restore(step.before);
    return step.label;
  };

  /** Back to just before the numbered step, so the history list is clickable. */
  const rewindTo = (index: number) => {
    for (let i = undoStack().length; i > index; i--) undo();
  };

  /** Drops the newest step without undoing it: for an operation that turned out to change nothing. */
  const forget = () => setUndoStack(steps => steps.slice(0, -1));

  return { undoStack, redoStack, checkpoint, undo, redo, rewindTo, forget };
}
