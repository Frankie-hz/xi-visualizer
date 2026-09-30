// node src/theme.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { contrastHue } from "./theme.ts";

const sand = { h: 61 / 360, s: 0.63, l: 0.67 };
const yellow = 58 / 360;
const turned = contrastHue(yellow, sand);
const apart = (a: number, b: number) => Math.abs(((a - b + 1.5) % 1) - 0.5);
assert.ok(apart(turned, sand.h) >= 0.2, `yellow over sand is turned away from it, to ${(turned * 360).toFixed(0)}°`);
assert.strictEqual(contrastHue(0.6, sand), 0.6, "blue over sand is left alone");
assert.strictEqual(contrastHue(yellow, { h: 0.1, s: 0.05, l: 0.35 }), yellow, "stone has no colour to clash with");
assert.strictEqual(contrastHue(yellow), yellow, "nothing known of the ground, nothing changed");
assert.ok(apart(contrastHue(0.98, { h: 0.02, s: 0.9, l: 0.5 }), 0.02) >= 0.2, "the wheel wraps");

console.log("ok");
