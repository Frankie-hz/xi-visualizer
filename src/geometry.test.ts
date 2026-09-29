// node src/geometry.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { convexHull, inRing, mostlyInside, ringDistance, segmentDistance, signedArea, withinRing } from "./geometry.ts";
import type { Ring } from "./regions.ts";

const square = (x: number, z: number, size: number): Ring => [[x, 0, z], [x + size, 0, z], [x + size, 0, z + size], [x, 0, z + size]];

assert.ok(inRing(square(0, 0, 10), 5, 5));
assert.ok(!inRing(square(0, 0, 10), 15, 5));
assert.strictEqual(Math.abs(signedArea(square(0, 0, 10))), 100);
assert.strictEqual(signedArea(square(0, 0, 10)), -signedArea([...square(0, 0, 10)].reverse()), "the sign is the winding");

assert.strictEqual(segmentDistance(5, 3, 0, 0, 10, 0), 3);
assert.strictEqual(segmentDistance(13, 4, 0, 0, 10, 0), 5, "past the end, from the end");

// A corner exactly on the edge counts only with the tolerance: the case that kept cut obstacles on offer.
assert.ok(withinRing(square(0, 0, 10), 10, 5, 0.25));
assert.ok(!withinRing(square(0, 0, 10), 11, 5, 0.25));

assert.strictEqual(ringDistance(square(0, 0, 10), square(13, 0, 5)), 3);

const hull = convexHull([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10], [5, 0, 5], [2, 0, 8]]);
assert.strictEqual(hull.length, 4, "the points inside are not on the hull");
assert.strictEqual(Math.abs(signedArea(hull)), 100);

assert.ok(mostlyInside(square(2, 2, 2), square(0, 0, 10)));
assert.ok(!mostlyInside(square(8, 8, 5), square(0, 0, 10)));

console.log("ok");
