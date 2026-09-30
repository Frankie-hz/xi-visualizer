// node src/components/history.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { createHistory } from "./history.ts";

let state = 0;
const h = createHistory(() => state, s => (state = s), 3);

h.checkpoint("one");
state = 1;
h.checkpoint("two");
state = 2;
h.undo();
assert.strictEqual(state, 1, "undo goes back to before the step");
h.redo();
assert.strictEqual(state, 2, "and redo forward again");

h.undo();
h.checkpoint("three");
state = 3;
assert.strictEqual(h.redoStack().length, 0, "a new step clears what could be redone");

h.rewindTo(0);
assert.strictEqual(state, 0, "rewinding to the first step undoes everything after it");
assert.deepStrictEqual(h.redoStack().map(s => s.label), ["three", "one"]);

h.checkpoint("nothing");
h.forget();
assert.strictEqual(h.undoStack().length, 0, "a step that changed nothing can be dropped");

for (let i = 0; i < 5; i++) h.checkpoint(`step ${i}`);
assert.strictEqual(h.undoStack().length, 3, "only so many steps are kept");

console.log("ok");
