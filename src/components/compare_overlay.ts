// What a pull request or a branch does to a zone, drawn over the editor's map: regions added green,
// removed red, reshaped amber with the ground they gave up and took in, the mobs it reassigned, and
// a wipe between before and after. Made by the region editor with what it needs passed in.
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import * as THREE from "three";
import { Line2, LineGeometry, LineMaterial, type MapControls } from "three/examples/jsm/Addons.js";
import { fillRef, paintOnce } from "../graphics/region_scene";
import { cleanupNode } from "../graphics/util";
import { regionDifference } from "../regions";
import type { Region, RegionsDiff, ZoneSide } from "../regions";
import { COLORS } from "../theme";

export const STATUS_COLOR = { added: COLORS.added, removed: COLORS.removed, reshaped: COLORS.reshaped, unchanged: COLORS.unchanged } as const;
export type ChangeStatus = keyof typeof STATUS_COLOR;

/** Both sides of the zone and what changed between them. */
export interface CompareSides {
  base: ZoneSide;
  head: ZoneSide;
  diff: RegionsDiff;
}

/** What to look at: a region by name, or one spawn by id. */
export type CompareFocus = { name?: string; spawn?: string; };

export interface CompareContext {
  sides: () => CompareSides | undefined;
  focus: () => CompareFocus | undefined;
  wipe: () => boolean;
  scene: () => THREE.Object3D;
  camera: () => THREE.PerspectiveCamera;
  controls: () => MapControls | undefined;
  canvas: () => HTMLCanvasElement;
}

/** A move names its regions joined with ", ", the way the list reads them out. */
const namesIn = (joined?: string | null) => (joined ? joined.split(", ") : []);

export function createCompare(ctx: CompareContext) {
  const statuses = createMemo(() => {
    const d = ctx.sides()?.diff;
    const map: Record<string, ChangeStatus> = {};
    if (!d) return map;
    for (const name of d.added) map[name] = "added";
    for (const name of d.removed) map[name] = "removed";
    for (const change of d.reshaped) map[change.name] = "reshaped";
    for (const name of d.unchanged) map[name] = "unchanged";
    return map;
  });

  const overlay = new THREE.Group();
  createEffect(() => {
    const scene = ctx.scene();
    scene.add(overlay);
    onCleanup(() => scene.remove(overlay));
  });
  const lineMaterials: LineMaterial[] = [];
  // Whatever is being looked at, drawn over everything so it is findable among the rest.
  const marker = new THREE.Group();
  marker.renderOrder = 6;
  createEffect(() => {
    const scene = ctx.scene();
    scene.add(marker);
    onCleanup(() => scene.remove(marker));
  });

  /**
   * `thick` draws the version that is there now; anything else is a before, dashed, since a thin
   * line under a thick one on nearly the same path looked like no change at all.
   */
  const outline = (region: Region, colour: number, thick: boolean, opacity: number, dashed = false, into: THREE.Group = overlay) => {
    const made: THREE.Material[] = [];
    for (const ring of region.rings) {
      if (ring.length < 2) continue;
      if (thick) {
        const points = ring.flat();
        points.push(...ring[0]);
        const geo = new LineGeometry();
        geo.setPositions(points);
        const mat = new LineMaterial({ color: colour, linewidth: 3, depthTest: false, transparent: true, opacity });
        mat.resolution.set(ctx.canvas().clientWidth, ctx.canvas().clientHeight);
        mat.userData.marker = into === marker;
        lineMaterials.push(mat);
        made.push(mat);
        const line = new Line2(geo, mat);
        line.renderOrder = 3;
        into.add(line);
      } else {
        const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        const geo = new THREE.BufferGeometry().setFromPoints([...points, points[0].clone()]);
        const line = new THREE.Line(
          geo,
          dashed
            ? new THREE.LineDashedMaterial({ color: colour, depthTest: false, transparent: true, opacity, dashSize: 4, gapSize: 3 })
            : new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity }),
        );
        if (dashed) line.computeLineDistances();
        line.renderOrder = 2;
        made.push(line.material as THREE.Material);
        into.add(line);
      }
    }
    return made;
  };

  let fills = 0; // numbers each fill for paintOnce
  const fill = (region: Region, color: number, opacity: number, into: THREE.Group = overlay) => {
    if ((region.rings[0]?.length ?? 0) < 3) return undefined;
    const flat = [region.rings[0], ...region.rings.slice(1).filter(h => h.length >= 3)];
    const faces = THREE.ShapeUtils.triangulateShape(
      flat[0].map(([x, , z]) => new THREE.Vector2(x, -z)),
      flat.slice(1).map(h => h.map(([x, , z]) => new THREE.Vector2(x, -z))),
    );
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flat.flat().flat()), 3));
    geo.setIndex(faces.flat());
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, ...paintOnce(fillRef(fills++)) }),
    );
    mesh.renderOrder = 1;
    into.add(mesh);
    return mesh.material;
  };

  /**
   * Where a spawn actually stands on one side: its own point, or the middle of each region placing
   * it. Several regions means the server picks one per spawn, so it stands in all of them.
   */
  const standsAt = (side: ZoneSide, id: string, regionNames?: string | null): { at: THREE.Vector3; name: string; }[] => {
    const spawn = side.spawns.find(sp => sp.id === id);
    if (spawn?.at) return [{ at: new THREE.Vector3(spawn.x, spawn.y, spawn.z), name: "its own spot" }];
    return namesIn(regionNames).flatMap(name => {
      const ring = side.regions[name]?.rings[0];
      if (!ring?.length) return [];
      const middle = ring.reduce((sum, [x, y, z]) => sum.add(new THREE.Vector3(x, y, z)), new THREE.Vector3());
      return [{ at: middle.divideScalar(ring.length), name }];
    });
  };

  createEffect(() => {
    const sides = ctx.sides();
    const status = statuses();
    while (overlay.children.length) cleanupNode(overlay.children.pop()!);
    for (let i = lineMaterials.length; i--;) if (!lineMaterials[i].userData.marker) lineMaterials.splice(i, 1);
    if (!sides) return;

    for (const [name, kind] of Object.entries(status)) {
      const color = STATUS_COLOR[kind];
      const before = sides.base.regions[name];
      const after = sides.head.regions[name];
      // Everything drawn for this region is tagged with it, so picking one can dim the rest.
      const first = overlay.children.length;
      if (kind === "removed" || kind === "reshaped") {
        if (before) outline(before, color, false, 0.9, true);
        if (before && kind === "removed") fill(before, color, 0.3);
        // A reshape is what it gave up and what it took in, as ground: the strip cut off a region
        // is what a reviewer is looking for.
        if (before && after && kind === "reshaped") {
          for (const lost of regionDifference(before, after)) fill(lost, STATUS_COLOR.removed, 0.85);
          for (const gained of regionDifference(after, before)) fill(gained, STATUS_COLOR.added, 0.7);
        }
      }
      if (after) {
        outline(after, color, kind !== "unchanged", kind === "unchanged" ? 0.35 : 1);
        if (kind !== "unchanged") fill(after, color, 0.22);
      }
      for (const child of overlay.children.slice(first) as (THREE.Object3D & { material: THREE.Material & { color: THREE.Color; opacity: number; }; })[]) {
        child.userData.region = name;
        child.userData.look = { color: child.material.color.getHex(), opacity: child.material.opacity };
      }
    }
    untrack(scope);

    // Spawns that changed region, at wherever the new file leaves them standing.
    const moved = sides.diff.moved.flatMap(m => {
      const now = standsAt(sides.head, m.id, m.to);
      return now.length ? now : standsAt(sides.base, m.id, m.from);
    });
    if (moved.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(moved.flatMap(({ at }) => [at.x, at.y, at.z])), 3));
      const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: STATUS_COLOR.reshaped, size: 7, sizeAttenuation: false, depthTest: false }));
      points.renderOrder = 4;
      overlay.add(points);
    }
  });

  /**
   * The wipe: the regions as the base had them left of a line, as the head has them right of it.
   * Drawn whole on both sides and clipped at the line, which follows the handle and the camera.
   */
  const [split, setSplit] = createSignal(0.5);
  const wipeGroup = new THREE.Group();
  const beforePlane = new THREE.Plane();
  const afterPlane = new THREE.Plane();
  createEffect(() => {
    const sides = ctx.sides();
    const status = statuses();
    const on = ctx.wipe() && !!sides;
    overlay.visible = !on;
    if (!on) return;
    const before = new THREE.Group(), after = new THREE.Group();
    for (const [name, kind] of Object.entries(status)) {
      const color = STATUS_COLOR[kind];
      for (const [side, region] of [[before, sides!.base.regions[name]], [after, sides!.head.regions[name]]] as const) {
        if (!region) continue;
        fill(region, color, kind === "unchanged" ? 0.12 : 0.3, side);
        outline(region, color, kind !== "unchanged", kind === "unchanged" ? 0.4 : 1, false, side);
      }
    }
    for (const [group, plane] of [[before, beforePlane], [after, afterPlane]] as const) {
      group.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.clippingPlanes = [plane];
      });
      wipeGroup.add(group);
    }
    const scene = ctx.scene();
    scene.add(wipeGroup);
    onCleanup(() => {
      scene.remove(wipeGroup);
      for (const group of [before, after]) {
        wipeGroup.remove(group);
        cleanupNode(group);
      }
    });
  });
  /** Puts the clipping planes through the camera and the handle's line on screen, this frame. */
  const placeWipe = () => {
    const cam = ctx.camera();
    const x = split() * 2 - 1;
    const top = new THREE.Vector3(x, 1, 0.5).unproject(cam);
    const bottom = new THREE.Vector3(x, -1, 0.5).unproject(cam);
    beforePlane.setFromCoplanarPoints(cam.position, bottom, top);
    // Three.js keeps what is on a plane's positive side; the before side is the left of the line.
    if (beforePlane.distanceToPoint(new THREE.Vector3(x - 0.2, 0, 0.5).unproject(cam)) < 0) beforePlane.negate();
    afterPlane.copy(beforePlane).negate();
  };
  const dragWipe = (e: PointerEvent) => {
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = ctx.canvas().getBoundingClientRect();
      setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width)));
    };
    const stop = () => (bar.removeEventListener("pointermove", move), bar.removeEventListener("pointerup", stop));
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", stop);
  };

  /** With a region or a move picked, everything else goes grey and faint. */
  const inScope = (): Set<string> | undefined => {
    const want = ctx.focus();
    if (want?.name) return new Set([want.name]);
    if (want?.spawn) {
      const move = ctx.sides()?.diff.moved.find(m => m.id === want.spawn);
      return new Set([...namesIn(move?.from), ...namesIn(move?.to)]);
    }
    return undefined;
  };
  const DIM = 0x64748b;
  const scope = () => {
    const keep = inScope();
    for (const child of overlay.children as (THREE.Object3D & { material: THREE.Material & { color: THREE.Color; opacity: number; }; })[]) {
      const look = child.userData.look as { color: number; opacity: number; } | undefined;
      if (!look) continue;
      const dim = !!keep && !keep.has(child.userData.region);
      child.material.color.setHex(dim ? DIM : look.color);
      child.material.opacity = dim ? look.opacity * 0.4 : look.opacity;
    }
  };
  createEffect(scope);

  /**
   * A move in progress: a dot walking from where the mob was to where it is now, on a loop, the
   * region it left fading as it goes and the one it was given taking over.
   */
  type Faded = { material: THREE.Material; peak: number; };
  interface Walk {
    legs: { from: THREE.Vector3; to: THREE.Vector3; dot: THREE.Object3D; }[];
    leaving: Faded[];
    arriving: Faded[];
    elapsed: number;
  }
  let walking: Walk | null = null;
  const faded = (materials: (THREE.Material | undefined)[]): Faded[] =>
    materials.flatMap(m => (m ? [{ material: m, peak: (m as THREE.Material & { opacity: number; }).opacity }] : []));
  const [legs, setLegs] = createSignal<{ text: string; dot: THREE.Object3D; }[]>([]);

  const roundDot = (() => {
    let texture: THREE.Texture | undefined;
    return () => {
      if (texture) return texture;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const c = canvas.getContext("2d")!;
      c.beginPath();
      c.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      c.fillStyle = "#fff";
      c.fill();
      texture = new THREE.CanvasTexture(canvas);
      return texture;
    };
  })();
  onCleanup(() => roundDot().dispose());

  const pin = (at: THREE.Vector3, colour: number) => {
    const group = new THREE.Group();
    group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([at, at.clone().setY(at.y + 30)]),
        new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
      ),
    );
    group.add(
      new THREE.Points(
        new THREE.BufferGeometry().setFromPoints([at]),
        new THREE.PointsMaterial({ color: colour, size: 12, sizeAttenuation: false, depthTest: false, map: roundDot(), transparent: true }),
      ),
    );
    return group;
  };

  /** Frames a box of zone points, keeping the angle the camera is looking from. */
  const frame = (box: THREE.Box3, minRadius: number) => {
    const controls = ctx.controls();
    if (!controls || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const centre = new THREE.Vector3(c.x, -c.y, -c.z);
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, minRadius);
    const cam = ctx.camera();
    const distance = (radius * 1.1) / Math.tan((cam.fov * Math.PI) / 360);
    const direction = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
    if (!direction.lengthSq()) direction.set(0, 1, 0);
    controls.target.copy(centre);
    cam.position.copy(centre).addScaledVector(direction, distance);
    controls.update();
  };

  createEffect(() => {
    const want = ctx.focus();
    const sides = ctx.sides();
    walking = null;
    setLegs([]);
    while (marker.children.length) cleanupNode(marker.children.pop()!);
    for (let i = lineMaterials.length; i--;) if (lineMaterials[i].userData.marker) lineMaterials.splice(i, 1);
    if (!want || !sides) return;
    const box = new THREE.Box3();

    if (want.spawn) {
      // A spawn placed by a region has no point of its own, so "where it is" means that region.
      const move = sides.diff.moved.find(m => m.id === want.spawn);
      const froms = standsAt(sides.base, want.spawn, move?.from);
      const tos = standsAt(sides.head, want.spawn, move?.to);
      if (!froms.length && !tos.length) return;
      const leaving: Faded[] = [];
      const arriving: Faded[] = [];
      for (const name of namesIn(move?.from)) {
        const region = sides.base.regions[name];
        if (region?.rings[0]?.length) {
          leaving.push(...faded([...outline(region, STATUS_COLOR.removed, true, 1, false, marker), fill(region, STATUS_COLOR.removed, 0.35, marker)]));
        }
      }
      for (const name of namesIn(move?.to)) {
        const region = sides.head.regions[name];
        if (region?.rings[0]?.length) {
          arriving.push(...faded([...outline(region, STATUS_COLOR.added, true, 1, false, marker), fill(region, STATUS_COLOR.added, 0.35, marker)]));
        }
      }
      for (const { at } of froms) (marker.add(pin(at, STATUS_COLOR.removed)), box.expandByPoint(at));
      for (const { at } of tos) (marker.add(pin(at, STATUS_COLOR.added)), box.expandByPoint(at));
      // A dot for every way it could have gone: one region to several is a dot to each of them.
      const walkLegs: Walk["legs"] = [];
      const labels: { text: string; dot: THREE.Object3D; }[] = [];
      for (const { at: from, name: fromName } of froms) {
        for (const { at: to, name: toName } of tos) {
          marker.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([from.clone().setY(from.y + 20), to.clone().setY(to.y + 20)]),
              new THREE.LineBasicMaterial({ color: 0xfff066, depthTest: false, transparent: true, opacity: 0.35 }),
            ),
          );
          const dot = new THREE.Points(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
            new THREE.PointsMaterial({ color: 0xfff066, size: 16, sizeAttenuation: false, depthTest: false, map: roundDot(), transparent: true }),
          );
          marker.add(dot);
          walkLegs.push({ from: from.clone().setY(from.y + 20), to: to.clone().setY(to.y + 20), dot });
          labels.push({ text: `${move?.name ?? want.spawn} · ${fromName} → ${toName}`, dot });
        }
      }
      if (walkLegs.length) {
        walking = { legs: walkLegs, leaving, arriving, elapsed: 0 };
        setLegs(labels);
      }
      untrack(() => frame(box, 20));
    } else if (want.name) {
      const region = sides.head.regions[want.name] ?? sides.base.regions[want.name];
      if (!region?.rings[0]?.length) return;
      for (const ring of region.rings) {
        if (ring.length < 2) continue;
        const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
        points.push(points[0].clone());
        marker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xfff066, depthTest: false })));
        for (const [x, y, z] of ring) box.expandByPoint(new THREE.Vector3(x, y, z));
      }
      untrack(() => frame(box, 12));
    }
  });

  /** Each frame: the walking dot, the wipe's planes, and the wide lines' size on screen. */
  const onFrame = (dt: number) => {
    if (walking) {
      const TRAVEL = 1.6, PAUSE = 0.7;
      walking.elapsed = (walking.elapsed + dt) % (TRAVEL + PAUSE);
      const t = Math.min(walking.elapsed / TRAVEL, 1);
      const eased = t * t * (3 - 2 * t);
      for (const leg of walking.legs) leg.dot.position.lerpVectors(leg.from, leg.to, eased);
      for (const { material, peak } of walking.leaving) (material as THREE.Material & { opacity: number; }).opacity = peak * (1 - eased * 0.9);
      for (const { material, peak } of walking.arriving) (material as THREE.Material & { opacity: number; }).opacity = peak * (0.1 + eased * 0.9);
    }
    const canvas = ctx.canvas();
    for (const m of lineMaterials) m.resolution.set(canvas.clientWidth, canvas.clientHeight);
    if (ctx.wipe() && ctx.sides()) placeWipe();
  };

  onCleanup(() => {
    cleanupNode(overlay);
    cleanupNode(marker);
  });

  return { statuses, split, dragWipe, legs, onFrame };
}
