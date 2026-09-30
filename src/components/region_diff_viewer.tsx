import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import * as THREE from "three";
import { Line2, LineGeometry, LineMaterial, MapControls } from "three/examples/jsm/Addons.js";
import { createMapCamera, fitCameraToContents } from "../graphics/camera";
import { addNavMesh, addZoneMesh, fillRef, paintOnce } from "../graphics/region_scene";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode } from "../graphics/util";
import { createViewer } from "../graphics/viewer";
import { regionDifference } from "../regions";
import type { Region, RegionsDiff, ZoneSide } from "../regions";
import { COLORS, css } from "../theme";
import type { ZoneData } from "../types";
import { copyText } from "../util";
import { CursorReadout, xyz } from "./map_overlays";

export const STATUS_COLOR = { added: COLORS.added, removed: COLORS.removed, reshaped: COLORS.reshaped, unchanged: COLORS.unchanged } as const;

export type ChangeStatus = keyof typeof STATUS_COLOR;

interface DiffViewerProps {
  zoneData: ZoneData;
  base: ZoneSide;
  head: ZoneSide;
  diff: RegionsDiff;
  /** What to go and look at: a region by name, or one spawn by id. Set it again with a new object
   * to re-trigger, since asking for the same thing twice is a thing people do. */
  focus?: { name?: string; spawn?: string; };
  /** Recorded roam points, xyz flat, of whatever is in focus. */
  trail?: Float32Array;
  /** The zone's navmesh, drawn in place of the collision mesh while present. */
  nav?: ArrayBuffer;
  /** Clicking a label on the map is the same act as clicking its row in the list. */
  onPick?: (name: string) => void;
  /** Before and after side by side instead of laid over each other, split by a handle to drag. */
  wipe?: boolean;
}

export default function RegionDiffViewer(props: DiffViewerProps) {
  let canvasElement!: HTMLCanvasElement;
  let controls: MapControls | undefined;

  const scene = createMemo(() => setupBaseScene());
  const camera = createMemo(() => createMapCamera(20000));

  const statuses = createMemo(() => {
    const map: Record<string, ChangeStatus> = {};
    for (const name of props.diff.added) map[name] = "added";
    for (const name of props.diff.removed) map[name] = "removed";
    for (const change of props.diff.reshaped) map[change.name] = "reshaped";
    for (const name of props.diff.unchanged) map[name] = "unchanged";
    return map;
  });

  const overlay = new THREE.Group();
  const labelRefs = new Map<string, HTMLDivElement>();
  const lineMaterials: LineMaterial[] = [];

  let zoneMesh: THREE.Mesh | undefined;
  // Zone coordinates under the cursor, for reading a spot off the map and copying it.
  const [cursor, setCursor] = createSignal<THREE.Vector3 | undefined>();
  const [toast, setToast] = createSignal<string | undefined>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = async (text: string) => {
    setToast((await copyText(text)) ? `copied ${text}` : "the browser would not let this page use the clipboard");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 2400);
  };
  onCleanup(() => clearTimeout(toastTimer));

  // The navmesh stands in for the terrain: both at once is unreadable, and the collision mesh is
  // still there underneath for the cursor to read positions off.
  createEffect(() => {
    const bytes = props.nav;
    if (zoneMesh) zoneMesh.visible = !bytes;
    if (!bytes) return;
    onCleanup(addNavMesh(scene(), bytes));
  });

  createMemo(() => {
    // Quieter than the editor's: here the regions are the whole point.
    const { mesh, dispose } = addZoneMesh(scene(), props.zoneData, 0.5);
    zoneMesh = mesh;
    scene().add(overlay);
    onCleanup(() => {
      dispose();
      if (zoneMesh === mesh) zoneMesh = undefined;
    });
  });

  /**
   * `thick` draws the version that is there now; anything else is a before.
   *
   * A before used to be the same colour, thinner. When a reshape is a simplification the outline
   * follows nearly the same path, so the thin line sat underneath the thick one and there was
   * nothing to see -- the change looked like no change. Dashes read through an overlap.
   */
  const outline = (
    region: Region,
    colour: number,
    thick: boolean,
    opacity: number,
    dashed = false,
    into: THREE.Group = overlay,
  ) => {
    const made: THREE.Material[] = [];
    for (const ring of region.rings) {
      if (ring.length < 2) continue;
      if (thick) {
        const points = ring.flat();
        points.push(...ring[0]);
        const geo = new LineGeometry();
        geo.setPositions(points);
        const mat = new LineMaterial({ color: colour, linewidth: 3, depthTest: false, transparent: true, opacity });
        mat.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        mat.userData.marker = into !== overlay;
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

  createEffect(() => {
    const status = statuses();
    while (overlay.children.length) {
      const child = overlay.children.pop() as THREE.Mesh;
      child.geometry?.dispose();
      (child.material as THREE.Material)?.dispose();
    }
    lineMaterials.length = 0;

    for (const [name, kind] of Object.entries(status)) {
      const color = STATUS_COLOR[kind];
      const before = props.base.regions[name];
      const after = props.head.regions[name];
      // Everything drawn for this region is tagged with it, so picking one can hide the rest.
      const first = overlay.children.length;

      if (kind === "removed" || kind === "reshaped") {
        // What the old file said, dashed in the region's own colour. It used to go red on a
        // reshape, which read as the whole region being removed; what was removed is painted
        // as ground below, and a hole gained or lost is ground like any other.
        if (before) outline(before, color, false, 0.9, true);
        if (before && kind === "removed") fill(before, color, 0.3);
        // A reshape is what it gave up and what it took in, as ground rather than two outlines
        // laid over each other: the strip cut off a region is what a reviewer is looking for,
        // and a dashed line a few pixels from a solid one never said where it was.
        if (before && after && kind === "reshaped") {
          // Solid, not a tint: a strip of red ground is the answer to "what did this take out".
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

    // Spawns that changed region, at wherever the new file leaves them standing: their own point, or
    // the middle of each region placing them. Most have no point of their own once a region places
    // them, so drawing only those with one left nearly every reassignment off the map.
    const moved = props.diff.moved.flatMap(m => {
      const now = standsAt(props.head, m.id, m.to);
      return now.length ? now : standsAt(props.base, m.id, m.from);
    });
    if (moved.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(moved.flatMap(({ at }) => [at.x, at.y, at.z])), 3));
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color: STATUS_COLOR.reshaped, size: 7, sizeAttenuation: false, depthTest: false }),
      );
      points.renderOrder = 4;
      overlay.add(points);
    }
  });

  /**
   * The wipe: the regions as the base had them left of a line, as the head has them right of it,
   * each in its change's colour. Drawn whole on both sides and clipped at the line, which follows
   * the handle and the camera, so dragging it across a reshape shows the one turn into the other.
   */
  const [split, setSplit] = createSignal(0.5);
  const wipeGroup = new THREE.Group();
  const beforePlane = new THREE.Plane();
  const afterPlane = new THREE.Plane();
  createEffect(() => {
    const status = statuses();
    const on = !!props.wipe;
    overlay.visible = !on;
    if (!on) return;
    const before = new THREE.Group(), after = new THREE.Group();
    for (const [name, kind] of Object.entries(status)) {
      const color = STATUS_COLOR[kind];
      for (const [side, region] of [[before, props.base.regions[name]], [after, props.head.regions[name]]] as const) {
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
    if (!wipeGroup.parent) scene().add(wipeGroup);
    onCleanup(() => {
      for (const group of [before, after]) {
        wipeGroup.remove(group);
        group.traverse(o => {
          (o as THREE.Mesh).geometry?.dispose();
          ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
        });
      }
    });
  });
  /** Puts the clipping planes through the camera and the handle's line on screen, this frame. */
  const placeWipe = () => {
    const cam = camera();
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
      const rect = canvasElement.getBoundingClientRect();
      setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width)));
    };
    const stop = () => (bar.removeEventListener("pointermove", move), bar.removeEventListener("pointerup", stop));
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", stop);
  };

  /**
   * With a region or a move picked, everything else goes grey and faint: still there to be
   * judged against, but not competing in colour with the thing being judged. Escape restores it.
   */
  /** A move names its regions joined with ", ", the way the list reads them out. */
  const namesIn = (joined?: string | null) => (joined ? joined.split(", ") : []);

  const inScope = (): Set<string> | undefined => {
    const want = props.focus;
    if (want?.name) return new Set([want.name]);
    if (want?.spawn) {
      const move = props.diff.moved.find(m => m.id === want.spawn);
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
   * A move in progress: a dot walking from where the mob was to where it is now, on a loop.
   *
   * Two pins and a line say a move happened but leave which end is which to be worked out. A dot
   * that sets off from one and arrives at the other says it without a legend, and the region it
   * left is held bright while it goes and fades once it has gone.
   */
  interface Walk {
    /** One dot per pair of ends: a mob given several regions is going to each of them. */
    legs: { from: THREE.Vector3; to: THREE.Vector3; dot: THREE.Object3D; }[];
    /** The regions it left and the ones it was given, each material with the opacity it peaks at. */
    leaving: Faded[];
    arriving: Faded[];
    elapsed: number;
  }
  let walking: Walk | null = null;
  type Faded = { material: THREE.Material; peak: number; };
  const faded = (materials: (THREE.Material | undefined)[]): Faded[] =>
    materials.flatMap(m => (m ? [{ material: m, peak: (m as THREE.Material & { opacity: number; }).opacity }] : []));
  // What rides above each dot: who it is and which way this leg goes. The dot alone said a move
  // happened; with several legs, or several mobs in a row, it did not say whose or to where.
  const [legLabels, setLegLabels] = createSignal<string[]>([]);
  const legRefs: HTMLDivElement[] = [];

  // Whatever is being looked at, drawn on top of everything so it is findable among the rest.
  const marker = new THREE.Group();
  marker.renderOrder = 6;
  createEffect(() => scene().add(marker));
  onCleanup(() => cleanupNode(marker));

  /**
   * The scene carries zone coordinates and flips them on its scale, so anything added to it goes in
   * raw -- as the region outlines do. The camera is not in the scene graph and works in world
   * space, so a point handed to it has to be flipped. Mixing the two puts markers off the map while
   * the camera still goes to the right place, which is exactly how it looked.
   */
  const toWorld = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.y, -v.z);

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

  const ringLine = (ring: readonly (readonly number[])[], colour: number) => {
    const points = ring.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    points.push(points[0].clone());
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }),
    );
  };

  /** A round sprite, because a default point sprite is a square and a mob is not a cube. */
  const roundDot = (() => {
    let texture: THREE.Texture | undefined;
    return () => {
      if (texture) return texture;
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      texture = new THREE.CanvasTexture(canvas);
      onCleanup(() => texture?.dispose());
      return texture;
    };
  })();

  // The trail arrives on its own clock, after the focus and once the zone's roam file is down.
  const trailDots = new THREE.Group();
  trailDots.renderOrder = 5;
  createEffect(() => scene().add(trailDots));
  onCleanup(() => cleanupNode(trailDots));
  const trailMaterial = new THREE.PointsMaterial({
    color: 0x59f2ff,
    size: 4,
    sizeAttenuation: false,
    depthTest: false,
    map: roundDot(),
    transparent: true,
    opacity: 0.7,
  });
  onCleanup(() => trailMaterial.dispose());
  createEffect(() => {
    for (const old of trailDots.children as THREE.Points[]) old.geometry.dispose();
    trailDots.clear();
    if (!props.trail?.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(props.trail, 3));
    trailDots.add(new THREE.Points(geo, trailMaterial));
  });

  const pin = (at: THREE.Vector3, colour: number) => {
    const group = new THREE.Group();
    const stalk = new THREE.BufferGeometry().setFromPoints([at, at.clone().setY(at.y + 30)]);
    group.add(new THREE.Line(stalk, new THREE.LineBasicMaterial({ color: colour, depthTest: false })));
    const dot = new THREE.BufferGeometry().setFromPoints([at]);
    group.add(
      new THREE.Points(
        dot,
        new THREE.PointsMaterial({ color: colour, size: 12, sizeAttenuation: false, depthTest: false, map: roundDot(), transparent: true }),
      ),
    );
    return group;
  };

  createEffect(() => {
    const want = props.focus;
    walking = null;
    setLegLabels([]);
    while (marker.children.length) cleanupNode(marker.children.pop()!);
    for (let i = lineMaterials.length; i--;) if (lineMaterials[i].userData.marker) lineMaterials.splice(i, 1);
    if (!want || !controls) return;

    // Scene coordinates are flipped on the scale, so points go in negated on y and z.
    const box = new THREE.Box3();

    if (want.spawn) {
      // A move has two ends and showing one of them explains nothing. A spawn placed by a region
      // has no point of its own -- the region replaced it -- so "where it is" means that region.
      const move = props.diff.moved.find(m => m.id === want.spawn);
      const froms = standsAt(props.base, want.spawn, move?.from);
      const tos = standsAt(props.head, want.spawn, move?.to);
      if (!froms.length && !tos.length) return;

      // Both ends drawn heavy, outline and fill, and handed to the frame loop to cross-fade: the
      // region it left is loud while the dot sets off and gone by the time it arrives, when the
      // one it was given is at full strength.
      const leaving: Faded[] = [];
      const arriving: Faded[] = [];
      for (const name of namesIn(move?.from)) {
        const region = props.base.regions[name];
        if (!region?.rings[0]?.length) continue;
        leaving.push(...faded([...outline(region, STATUS_COLOR.removed, true, 1, false, marker), fill(region, STATUS_COLOR.removed, 0.35, marker)]));
      }
      for (const name of namesIn(move?.to)) {
        const region = props.head.regions[name];
        if (!region?.rings[0]?.length) continue;
        arriving.push(...faded([...outline(region, STATUS_COLOR.added, true, 1, false, marker), fill(region, STATUS_COLOR.added, 0.35, marker)]));
      }
      for (const { at } of froms) (marker.add(pin(at, STATUS_COLOR.removed)), box.expandByPoint(at));
      for (const { at } of tos) (marker.add(pin(at, STATUS_COLOR.added)), box.expandByPoint(at));

      // A dot for every way it could have gone: one region to several is a dot to each of them.
      const legs: Walk["legs"] = [];
      const labels: string[] = [];
      for (const { at: from, name: fromName } of froms) {
        for (const { at: to, name: toName } of tos) {
          labels.push(`${move?.name ?? want.spawn} · ${fromName} → ${toName}`);
          // The path it took, faint, so the route is there even between passes of the dot.
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
          legs.push({ from: from.clone().setY(from.y + 20), to: to.clone().setY(to.y + 20), dot });
        }
      }
      if (legs.length) {
        walking = { legs, leaving, arriving, elapsed: 0 };
        setLegLabels(labels);
      }
    } else if (want.name) {
      const region = props.head.regions[want.name] ?? props.base.regions[want.name];
      if (!region?.rings[0]?.length) return;
      for (const ring of region.rings) {
        if (ring.length < 2) continue;
        marker.add(ringLine(ring, 0xfff066));
        for (const [x, y, z] of ring) box.expandByPoint(new THREE.Vector3(x, y, z));
      }
    } else {
      return;
    }

    // Close enough that it fills the view rather than merely being in it, keeping whatever angle
    // the camera was already at. Both ends of a move have to fit, however far apart they are.
    const centre = toWorld(box.getCenter(new THREE.Vector3()));
    // Whatever is picked fills the frame: a vertex on a wall is a metre wide and the whole point
    // of looking. The floor only stops a move between two spots a yalm apart from framing a
    // patch of ground with nothing on it to say where it is.
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, want.spawn ? 20 : 12);
    const distance = (radius * 1.1) / Math.tan((camera().fov * Math.PI) / 360);
    const direction = new THREE.Vector3().subVectors(camera().position, controls.target).normalize();
    if (!direction.lengthSq()) direction.set(0, 1, 0);
    controls.target.copy(centre);
    camera().position.copy(centre).addScaledVector(direction, distance);
  });

  onMount(() => {
    const projected = new THREE.Vector3();
    const viewer = createViewer(canvasElement, {
      stencil: true, // for paintOnce
      scene: scene(),
      camera: camera(),
      onFrame: dt => {
        if (walking) {
          const TRAVEL = 1.6, PAUSE = 0.7;
          walking.elapsed = (walking.elapsed + dt) % (TRAVEL + PAUSE);
          const t = Math.min(walking.elapsed / TRAVEL, 1);
          // Eased, because something that sets off and arrives reads as going somewhere, where
          // something at constant speed reads as a moving decoration.
          const eased = t * t * (3 - 2 * t);
          for (const leg of walking.legs) leg.dot.position.lerpVectors(leg.from, leg.to, eased);
          // The region it left gives way as the dot goes; the one it was given takes over.
          for (const { material, peak } of walking.leaving) (material as THREE.Material & { opacity: number; }).opacity = peak * (1 - eased * 0.9);
          for (const { material, peak } of walking.arriving) (material as THREE.Material & { opacity: number; }).opacity = peak * (0.1 + eased * 0.9);
        }
        for (const m of lineMaterials) m.resolution.set(canvasElement.clientWidth, canvasElement.clientHeight);
        if (props.wipe) placeWipe();
      },
      onAfterRender: () => {
        // Each leg's label rides just above its dot, wherever the dot is this frame.
        walking?.legs.forEach((leg, i) => {
          const el = legRefs[i];
          if (!el) return;
          projected.copy(leg.dot.position).set(projected.x, -projected.y, -projected.z).project(camera());
          el.style.display = projected.z < 1 ? "block" : "none";
          el.style.transform = `translate(-50%, -100%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
            (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight - 12
          }px)`;
        });
        const keep = inScope();
        for (const [name, el] of labelRefs) {
          const ring = (props.head.regions[name] ?? props.base.regions[name])?.rings[0];
          el.style.opacity = keep && !keep.has(name) ? "0.35" : "";
          if (!ring?.length) {
            el.style.display = "none";
            continue;
          }
          let x = 0, y = 0, z = 0;
          for (const v of ring) (x += v[0], y += v[1], z += v[2]);
          projected.set(x / ring.length, -y / ring.length, -z / ring.length).project(camera());
          el.style.display = projected.z < 1 ? "block" : "none";
          el.style.transform = `translate(-50%, -50%) translate(${(projected.x * 0.5 + 0.5) * canvasElement.clientWidth}px, ${
            (-projected.y * 0.5 + 0.5) * canvasElement.clientHeight
          }px)`;
        }
      },
    });
    controls = viewer.controls;
    viewer.renderer.localClippingEnabled = true; // for the wipe
    fitCameraToContents(camera(), controls, fn => overlay.children.forEach(fn));

    // Where the cursor meets terrain. Only a real mesh hit counts: empty space has no position.
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const mouse = new THREE.Vector2();
    const groundPoint = (ev: MouseEvent) => {
      if (!zoneMesh) return undefined;
      const rect = canvasElement.getBoundingClientRect();
      mouse.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera());
      const hit = raycaster.intersectObject(zoneMesh, true)[0];
      return hit ? scene().worldToLocal(hit.point.clone()) : undefined;
    };
    const onMove = (ev: MouseEvent) => setCursor(groundPoint(ev));
    const onClick = (ev: MouseEvent) => {
      if (!ev.altKey) return;
      const p = groundPoint(ev);
      if (p) copy(`!pos ${xyz(p)}`);
    };
    canvasElement.addEventListener("mousemove", onMove);
    canvasElement.addEventListener("click", onClick);

    onCleanup(() => {
      canvasElement.removeEventListener("mousemove", onMove);
      canvasElement.removeEventListener("click", onClick);
      viewer.dispose();
    });
  });

  // Only changed regions get a label; naming the unchanged ones would bury the ones that matter.
  const labelled = createMemo(() => Object.entries(statuses()).filter(([, kind]) => kind !== "unchanged"));

  return (
    <div class="relative h-full">
      <canvas class="block w-full h-full outline-none" ref={canvasElement!} />
      <Show when={props.wipe}>
        <div class="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-white/80 pointer-events-none" style={{ left: `${split() * 100}%` }} />
        <div class="absolute top-10 -translate-x-full pr-2 text-xs font-bold text-slate-100 pointer-events-none" style={{ left: `${split() * 100}%` }}>
          before
        </div>
        <div class="absolute top-10 pl-2 text-xs font-bold text-slate-100 pointer-events-none" style={{ left: `${split() * 100}%` }}>after</div>
        <div
          class="absolute top-1/2 w-7 h-12 -translate-x-1/2 -translate-y-1/2 rounded-md bg-white text-slate-900 flex items-center justify-center cursor-ew-resize select-none shadow-lg touch-none"
          style={{ left: `${split() * 100}%` }}
          title="Drag to wipe between before and after"
          onPointerDown={dragWipe}
        >
          ⇔
        </div>
      </Show>
      {
        /* The layer ignores the mouse so the camera still drags through it; the labels take it
          back, since a name on the map is the most obvious thing to click. */
      }
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <For each={labelled()}>
          {([name, kind]) => {
            onCleanup(() => labelRefs.delete(name));
            return (
              <div
                ref={el => labelRefs.set(name, el)}
                class="absolute top-0 left-0 hidden whitespace-nowrap text-xs font-bold px-1.5 py-0.5 rounded bg-slate-900/80 pointer-events-auto cursor-pointer hover:bg-slate-800"
                style={{ color: css(STATUS_COLOR[kind]) }}
                title={`Look at ${name}`}
                onClick={() => props.onPick?.(name)}
              >
                {name}
              </div>
            );
          }}
        </For>
        <For each={legLabels()}>
          {(text, i) => (
            <div
              ref={el => (legRefs[i()] = el)}
              class="absolute top-0 left-0 hidden whitespace-nowrap text-xs px-1.5 py-0.5 rounded bg-slate-900/85 text-slate-100"
            >
              {text}
            </div>
          )}
        </For>
      </div>
      <div class="absolute top-2 left-2 flex gap-3 text-xs bg-slate-900/75 rounded px-2 py-1 pointer-events-none">
        <For each={Object.entries(STATUS_COLOR)}>
          {([kind, color]) => (
            <span style={{ color: css(color) }}>
              {kind}
              <Show when={kind === "reshaped"}>
                <span class="text-slate-500">(dashed = before, red ground = cut away, green = taken in)</span>
              </Show>
            </span>
          )}
        </For>
        <span style={{ color: css(STATUS_COLOR.reshaped) }}>● mob reassigned</span>
      </div>
      <Show when={cursor()}>{at => <CursorReadout at={at()} onCopy={copy} />}</Show>
      <Show when={toast()}>
        <div class="absolute bottom-2 right-2 text-xs text-slate-200 bg-slate-900/85 rounded px-2 py-1 pointer-events-none">{toast()}</div>
      </Show>
    </div>
  );
}
