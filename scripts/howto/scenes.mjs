// The HOWTO scenes recorded by record.mjs. Each step's `say` is the narration for it, and the step
// lasts at least as long as that takes to say. Positions are worked out from the editor at record
// time (window.__regionEditor on the dev server), so a scene follows the data rather than pixels.

// Shared by the in-page helpers below, which run in the browser and so cannot close over these.
const GEOMETRY = `
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, , zi] = ring[i], [xj, , zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const members = (e, name) => Object.entries(e.assign()).filter(([, ns]) => ns.includes(name)).map(([id]) => id);
`;

/**
 * Corner moves that bring a region's stray trail points inside, found the way a person would by
 * eye: try each corner near the points in a few directions and distances, keep the move that takes
 * in the most without crossing the outline or leaving anything out, and repeat near the first.
 */
const spill = (act, region, count = 6) =>
  act.page.evaluate(
    (name, count, geometry) => {
      const { inRing, members } = new Function(`${geometry}; return { inRing, members };`)();
      const e = window.__regionEditor;
      const ring = e.regions().find(r => r.name === name).rings[0].map(v => [...v]);
      const trail = members(e, name).flatMap(id => e.trail(id));
      const cross = (a, b, c, d) => {
        const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]));
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
      };
      const tangled = (r, i) => {
        const n = r.length, mine = [[(i - 1 + n) % n, i], [i, (i + 1) % n]];
        for (const [a, b] of mine) {
          for (let k = 0; k < n; k++) {
            const l = (k + 1) % n;
            if (k === a || k === b || l === a || l === b) continue;
            if (cross(r[a], r[b], r[k], r[l])) return true;
          }
        }
        return false;
      };
      const moves = [];
      let focus = null;
      for (let step = 0; step < count; step++) {
        const outside = trail.filter(p => !inRing(ring, p.x, p.z));
        let best = null;
        ring.forEach((v, i) => {
          if (focus && Math.hypot(v[0] - focus[0], v[2] - focus[2]) > 18) return;
          const local = trail.filter(p => Math.hypot(p.x - v[0], p.z - v[2]) < 14);
          if (!local.some(p => !inRing(ring, p.x, p.z))) return;
          const before = local.filter(p => inRing(ring, p.x, p.z)).length;
          for (let a = 0; a < 16; a++) {
            for (const d of [1.5, 3, 4.5, 6]) {
              const to = [v[0] + Math.cos((a * Math.PI) / 8) * d, v[1], v[2] + Math.sin((a * Math.PI) / 8) * d];
              const trial = ring.map((w, k) => (k === i ? to : w));
              if (tangled(trial, i)) continue;
              const after = local.filter(p => inRing(trial, p.x, p.z)).length;
              const gain = after - before - d * 0.5;
              if (after > before && (!best || gain > best.gain)) best = { i, to, gain };
            }
          }
        });
        if (!best || best.gain < 3) break;
        moves.push({ from: [...ring[best.i]], to: best.to });
        ring[best.i] = best.to;
        focus ??= best.to;
      }
      const at = moves.length ? [0, 1, 2].map(k => moves.reduce((s, m) => s + m.from[k], 0) / moves.length) : ring[0];
      return { at, moves };
    },
    region,
    count,
    GEOMETRY,
  );

/**
 * A hole's middle, and a couple of its sides with where to push each: both corners of the side
 * moved out square to it by the same amount, stopping a little short of the nearest recorded step.
 */
const holeSpots = (act, region, index, sides = 2) =>
  act.page.evaluate(
    (name, index, sides, geometry) => {
      const { members } = new Function(`${geometry}; return { members };`)();
      const e = window.__regionEditor;
      const hole = e.regions().find(r => r.name === name).rings[index];
      const n = hole.length;
      const c = [0, 1, 2].map(k => hole.reduce((s, v) => s + v[k], 0) / n);
      const near = members(e, name).flatMap(id => e.trail(id)).filter(p => Math.hypot(p.x - c[0], p.z - c[2]) < 20);
      const room = (v, ux, uz) => {
        let r = 6;
        for (const p of near) {
          const ax = p.x - v[0], az = p.z - v[2], along = ax * ux + az * uz;
          if (along > 0 && Math.abs(ax * uz - az * ux) < 1.5) r = Math.min(r, along);
        }
        return r;
      };
      const edges = hole.map((a, i) => {
        const b = hole[(i + 1) % n];
        let ux = b[2] - a[2], uz = -(b[0] - a[0]);
        const len = Math.hypot(ux, uz) || 1;
        (ux /= len), (uz /= len);
        const mx = (a[0] + b[0]) / 2 - c[0], mz = (a[2] + b[2]) / 2 - c[2];
        if (ux * mx + uz * mz < 0) (ux = -ux), (uz = -uz);
        const d = Math.min(Math.min(room(a, ux, uz), room(b, ux, uz)) - 1.2, 2);
        return { i, len, d, moves: [a, b].map(v => ({ from: v, to: [v[0] + ux * d, v[1], v[2] + uz * d] })) };
      });
      const picked = [];
      for (const edge of edges.filter(e => e.len > 1.5 && e.d > 0.8).sort((a, b) => b.len * b.d - a.len * a.d)) {
        if (picked.length < sides && picked.every(p => Math.min(Math.abs(p.i - edge.i), n - Math.abs(p.i - edge.i)) > 2)) picked.push(edge);
      }
      // A side's second corner is dragged after its first has moved, so it is looked up again then.
      return { centre: c, moves: picked.flatMap(p => p.moves) };
    },
    region,
    index,
    sides,
    GEOMETRY,
  );

/** Drags a range input's thumb from one value to another. */
const slide = async (act, label, from, to) => {
  const box = await act.page.evaluate(label => {
    const r = document.querySelector(`input[aria-label="${label}"]`).getBoundingClientRect();
    const el = document.querySelector(`input[aria-label="${label}"]`);
    return { x: r.x, y: r.y + r.height / 2, width: r.width, min: +el.min, max: +el.max };
  }, label);
  // The thumb's travel stops half a thumb short of each end.
  const at = v => ({ x: box.x + 8 + ((v - box.min) / (box.max - box.min)) * (box.width - 16), y: box.y });
  await act.drag(at(from), at(to), 1400);
};

/** The middle of a button in the mob list row for a spawn id, or of the row itself. */
const mobRow = (act, id, button) =>
  act.page.evaluate(
    (id, button) => {
      const row = [...document.querySelectorAll("div[title]")].find(d => d.title.includes(` ${id}`) && d.title.includes("click to keep its trail"));
      if (!row) return null;
      row.scrollIntoView({ block: "nearest" });
      const el = button ? row.querySelector(`button[aria-label^="${button}"]`) : row;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    id,
    button,
  );

/** Where a spawn stands, from the editor. */
const spawnAt = (act, id) =>
  act.page.evaluate(id => {
    const s = window.__regionEditor.spawns().find(s => s.id === id);
    return [s.x, s.y, s.z];
  }, id);

const selectRow = async (act, name) => {
  // The row's vertex count, not the name field: clicking the field starts a rename and does not zoom.
  const p = await act.page.evaluate(name => {
    const field = [...document.querySelectorAll("input")].find(e => e.value === name);
    field.scrollIntoView({ block: "nearest" });
    const r = field.nextElementSibling.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  await act.click(p.x, p.y);
  // Off the lists: a mob row under the pointer shows that mob's trail alone.
  await act.move(1100, 540);
  await act.settle(1200);
};

export const SCENES = [
  {
    id: "01-expand-outline",
    title: "Expanding a region's outline",
    summary: "A region drawn a little short of the ground its mobs roam: its corners are dragged out over the recorded trails, and the Review tab confirms it.",
    zone: "west_ronfaure",
    steps: [
      {
        say:
          "This is the spawn regions editor, open on West Ronfaure. Each coloured shape is a region: when a mob placed by it spawns, the server picks a spot somewhere inside.",
      },
      {
        say:
          "Opening the Review tab checks every region against the recorded trails. Back in the list, each region now shows how much of its mobs' trails it covers. North-west one-twelve is at eighty-five percent.",
        do: async act => {
          await act.press("button", "Review");
          await act.settle(2500);
          await act.press("button", "Regions");
          await act.hover("input", "nw_112", 900);
        },
      },
      {
        say: "Click the region in the list, or on the map, to select it. The editor zooms in on it.",
        do: act => selectRow(act, "nw_112"),
      },
      {
        say:
          "The dots are roam trails: where this region's own mobs were actually recorded walking. Here they spill past the edge, onto ground the server will never spawn them on.",
        do: async act => {
          act.plan = await spill(act, "nw_112");
          const { at } = act.plan;
          await act.page.evaluate(at => window.__regionEditor.look(at[0], at[1], at[2], 40, 1800), at);
          await act.settle(800);
        },
      },
      {
        say:
          "Drag the corners out, one by one, until the dots are inside. The big squares are corners; the small ones in the middle of an edge add a new corner when dragged.",
        do: async act => {
          for (const m of act.plan.moves) await act.drag(await act.project(...m.from), await act.project(...m.to), 900);
        },
      },
      { say: "A corner you don't want goes with a right-click on it, and Control Z undoes the last change." },
      {
        say: "For a region that is off everywhere, Refit rebuilds the whole outline from its mobs' trails in one go. Here, a few corners were enough.",
        do: act => act.hover("button", "Refit", 900),
      },
      {
        say:
          "Open Review again to recount, and back in the list the coverage has gone up. That figure is the one to watch, since it is measured against where the mobs really went.",
        do: async act => {
          await act.press("button", "Review");
          await act.settle(2500);
          await act.press("button", "Regions");
          await act.hover("input", "nw_112", 900);
        },
      },
      { say: "When the outline looks right, sign in and Save: the change goes to your own branch, ready for a pull request." },
    ],
  },
  {
    id: "02-expand-hole",
    title: "Expanding a hole",
    summary: "A hole cut smaller than the tree it stands for: its corners are dragged out by hand, then Grow to roam data sizes it from the trails.",
    zone: "jugner_forest",
    steps: [
      {
        say:
          "Holes mark ground inside a region where the mobs never go: trees, rocks, water. The server never spawns a mob in a hole, so a hole that is too small lets one spawn inside a tree.",
      },
      {
        say: "This is Jugner Forest. Select the region, here west seventy-six, and find the hole. Hovering it shows its size.",
        do: async act => {
          await selectRow(act, "w_76");
          act.hole = await holeSpots(act, "w_76", 39);
          const [x, y, z] = act.hole.centre;
          await act.page.evaluate((x, y, z) => window.__regionEditor.look(x, y, z, 26, 1800), x, y, z);
          await act.settle(600);
          const c = await act.project(x, y, z);
          await act.move(c.x, c.y, 900);
        },
      },
      { say: "The dots circle it, but stop a good way short of its edge. Nothing was ever recorded in that gap, so the tree is wider than the hole." },
      {
        say: "Drag the hole's corners outward, the same way as an outline's: a whole side at a time, stopping just short of the dots.",
        do: async act => {
          for (const m of act.hole.moves) await act.drag(await act.project(...m.from), await act.project(...m.to), 900);
        },
      },
      {
        say: "Or let the editor size it. Right-click inside the hole and choose Grow to roam data.",
        do: async act => {
          const c = await act.project(...act.hole.centre);
          await act.click(c.x, c.y, "right");
          await act.settle(700);
          await act.press("button", "Grow to roam data");
          await act.settle(800);
        },
      },
      {
        say:
          "The preview grows the hole over all the ground around it that no mob walked on. Clearance keeps its edge that far from the nearest recorded step; a larger clearance gives a smaller hole.",
        do: async act => {
          await slide(act, "clearance", 1, 3);
          await act.settle(1200);
          await slide(act, "clearance", 3, 2);
        },
      },
      {
        say: "Apply cuts it.",
        do: async act => {
          await act.press("button", "Apply");
          await act.settle(900);
          const c = await act.project(...act.hole.centre);
          await act.move(c.x, c.y, 900);
        },
      },
      { say: "The same right-click menu deletes a hole, or merges it with the holes around it. And Control Z undoes any of it." },
    ],
  },
  {
    id: "03-auto-carve",
    title: "Carving holes automatically",
    summary:
      "A forest region with trees still uncut: the Carve holes tool rings every obstacle the collision mesh shows and cuts the patches no mob was recorded on.",
    zone: "jugner_forest",
    steps: [
      {
        say:
          "This is Jugner Forest. Every tree or rock inside a region that is not cut out as a hole is ground where the server may try to spawn a mob. Cutting them one at a time is slow; the Carve holes tool finds them for you.",
      },
      {
        say: "Select the region, here east three-ten. Some of its trees have holes, several do not.",
        do: act => selectRow(act, "e_310"),
      },
      {
        say: "The Spawns button shows it: green is where the server would put a mob, red a spot it throws away because it is off the walkable ground.",
        do: async act => {
          await act.press("button", "Spawns");
          await act.settle(4000);
        },
      },
      {
        say: "Open Carve holes. Amber outlines are obstacles found in the zone's collision mesh; violet dashed ones are patches no mob was ever recorded on.",
        do: async act => {
          await act.press("button", "Spawns");
          await act.press("button", "Carve holes");
          await act.settle(2500);
        },
      },
      {
        say: "Hover Ring all to preview everything it would cut.",
        do: async act => {
          await act.hover("button", "Ring all", 900);
          await act.settle(2000);
        },
      },
      {
        say: "Click it, and each obstacle becomes a hole.",
        do: async act => {
          await act.press("button", "Ring all");
          await act.settle(2500);
        },
      },
      {
        say: "Cut patches does the same for the empty ground. The clearance dial above it keeps each patch that far from where mobs walked.",
        do: async act => {
          await act.hover("button", "Cut patches", 900);
          await act.settle(2500);
          await act.press("button", "Cut patches");
          await act.settle(2500);
        },
      },
      {
        say:
          "A cut that would split the region in two is left alone, and says so. Anything left dashed is too big for Ring all, usually a cliff or a hillside: click it on the map to cut it on its own, or leave it.",
      },
      {
        say: "Press Escape to leave the tool. The new holes are ordinary holes: drag, grow or delete them like any other.",
        do: async act => {
          await act.key("Escape");
          await act.settle(1500);
        },
      },
      { say: "Every cut is one step in History, so Control Z takes back the last one if it went too far." },
    ],
  },
  {
    id: "04-assign-mob",
    title: "Assigning a mob to a region",
    summary: "Two mobs pinned to a fixed point although their recorded trails fill a region: one is assigned from the mob list, the other with Assign inside.",
    zone: "valkurm_dunes",
    steps: [
      {
        say:
          "This is Valkurm Dunes. A mob with no region spawns on the same fixed point every time. Assigned to a region, it spawns anywhere inside it instead.",
      },
      {
        say: "The mob list on the left has a Fixed filter for the mobs still on a point. Type in the box to narrow it down, here to the goblin bounty hunters.",
        do: async act => {
          await act.press("button", "Fixed");
          await act.settle(600);
          const box = await act.where("input[placeholder^='Filter (template']");
          await act.click(box.x, box.y);
          await act.page.keyboard.type("Goblin_Bounty", { delay: 90 });
          await act.settle(800);
        },
      },
      {
        say: "Hovering a row shows that mob's recorded trail on the map.",
        do: async act => {
          const p = await mobRow(act, "17199650");
          await act.move(p.x, p.y, 900);
          await act.settle(1500);
        },
      },
      {
        say: "Its trail lies almost entirely inside region thirty-nine, the same ground that region's other mobs roam. Select that region.",
        do: async act => {
          await selectRow(act, "region_39");
          const [x, y, z] = await spawnAt(act, "17199650");
          await act.page.evaluate((x, y, z) => window.__regionEditor.look(x, y, z, 110, 1500), x, y, z);
          const p = await mobRow(act, "17199650");
          await act.move(p.x, p.y, 900);
          await act.settle(1200);
        },
      },
      {
        say: "With a region selected, each row has a plus button. Click it to assign the mob to the region.",
        do: async act => {
          const p = await mobRow(act, "17199650", "Assign to");
          await act.click(p.x, p.y);
          await act.settle(1200);
        },
      },
      {
        say:
          "To place every unplaced mob standing inside the selected region at once, use Assign inside, under the region list. The count on it says how many it will take.",
        do: async act => {
          await act.hover("button", "Assign inside", 900);
          await act.settle(1500);
          await act.press("button", "Assign inside");
          await act.settle(1200);
        },
      },
      {
        say:
          "Both goblins now spawn anywhere in region thirty-nine. The list shows the region each one belongs to, and with hide mobs that have a region ticked, their dots leave the map.",
        do: async act => {
          await act.press("button", "All");
          await act.settle(1500);
        },
      },
      { say: "A mob's row also has a right-click menu, and the cross beside it in the region's mob list takes it back out. Save when done." },
    ],
  },
];
