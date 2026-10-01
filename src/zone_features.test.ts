// node src/zone_features.test.ts  (run by `pnpm test`)
import assert from "node:assert";
import { parseTriggerAreas, parseZoneLines } from "./zone_features.ts";

const lua = `
zoneObject.onInitialize = function(zone)
    zone:registerCuboidTriggerArea(1, 375, -10, 259, 460, 10, 420)
    zone:registerCuboidTriggerArea(2, -5, 0, -5, 5, 2, 5, 1.57)
    zone:registerCylindricalTriggerArea(3, -40.5, 120, 7)
    zone:registerSphericalTriggerArea(4, 1, -2, 3, 10)
    zone:registerCylindricalTriggerArea(ID.npc.BASE + i, npc:getXPos(), npc:getZPos(), 5)
end`;
const { areas, computed } = parseTriggerAreas(lua);
assert.deepStrictEqual(areas.map(a => a.kind), ["cuboid", "cuboid", "cylinder", "sphere"]);
assert.deepStrictEqual(areas[0], { kind: "cuboid", id: 1, min: [375, -10, 259], max: [460, 10, 420], rotation: 0 });
assert.strictEqual((areas[1] as { rotation: number; }).rotation, 1.57, "a cuboid's optional rotation");
assert.deepStrictEqual(areas[2], { kind: "cylinder", id: 3, x: -40.5, z: 120, radius: 7 });
assert.strictEqual(computed, 1, "a call built from the script's own values is counted, not guessed at");

const lines = parseZoneLines(`
zonelines:

  z2s0:
    from:  [-119.065, -65.707, 280.921]
    to:    southern_san_doria
    at:    [-110.465, -2.083, -54.469, 5.497787]
    scale: [1.000, 5.000]

  z2s2:
    from:  [-157.666, -66.124, 379.960]
    to:    northern_san_doria
    at:    [-248.893, 4.640, 44.026]
    scale: [1.000, 5.000]
`);
assert.strictEqual(lines.length, 2);
assert.deepStrictEqual(lines[0], {
  id: "z2s0",
  from: [-119.065, -65.707, 280.921],
  to: "southern_san_doria",
  at: [-110.465, -2.083, -54.469],
  facing: 5.497787,
  scale: [1, 5],
});
assert.strictEqual(lines[1].facing, undefined);
assert.deepStrictEqual(parseZoneLines("type: [outdoors]\n"), [], "a zone with no zone lines");

console.log("ok");
