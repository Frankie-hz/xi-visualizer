// Scene pieces the regions editor and the regions diff both draw the same way.
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { ZoneData } from "../types";
import { buildNavMeshGroup, parseNavMesh } from "./navmesh";
import { cleanupNode } from "./util";
import { ColorKind, createZoneMesh, prepareMeshData } from "./ximesh";

// Raycasts against the zone mesh go through a bounds tree: a few hundred thousand triangles
// tested one by one on every mouse move is what made clicking slow.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * The zone's collision mesh, coloured by material and dimmed by `brightness` so it reads as ground
 * under whatever is drawn over it. The mesh is unlit, so one flat grey would have no walls, water
 * or floor in it. Added to `scene`; the returned `dispose` takes it out again.
 */
export function addZoneMesh(scene: THREE.Object3D, zone: ZoneData, brightness: number) {
  const prep = prepareMeshData(zone.mesh);
  const mesh = createZoneMesh(zone.id, zone.mesh, prep, ColorKind.Materials);
  // ximesh writes byte colours without flagging them normalized, which blows them out to white.
  (mesh.geometry.getAttribute("color") as THREE.BufferAttribute).normalized = true;
  // Lit, from a low sun off to one side: unlit, a hillside and the flat beside it were one colour,
  // and a vertex that had climbed a wall looked like one that had not.
  (mesh.material as THREE.Material).dispose();
  const lit = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
  lit.color.setScalar(brightness * 1.25);
  (mesh as THREE.Mesh).material = lit;
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.position.set(-400, 900, 250);
  scene.add(mesh, sun, sun.target);
  return {
    mesh,
    prep,
    dispose: () => {
      scene.remove(mesh, sun, sun.target);
      cleanupNode(mesh);
    },
  };
}

/** The server's navmesh as a translucent overlay, added to `scene`; `dispose` takes it out again. */
export function addNavMesh(scene: THREE.Object3D, bytes: ArrayBuffer) {
  const group = buildNavMeshGroup(parseNavMesh(bytes), {
    showSurface: true,
    showEdges: true,
    colorByTile: false,
    colorByComponent: false,
    showOffMesh: false,
    joinByLinks: false,
    opacity: 0.55,
  });
  scene.add(group);
  return () => {
    scene.remove(group);
    cleanupNode(group);
  };
}

/**
 * Material settings that let one fill paint each pixel once. A region's fill keeps every vertex's
 * height, so with holes it is a bent sheet of long thin triangles that overlap on screen from a low
 * angle; translucent and without a depth test, each overlap doubled the colour into bands. The
 * first triangle at a pixel marks it with `ref`, and later ones carrying the same `ref` skip it.
 * Give each fill its own `ref`, 1 to 254 (255 is the carve preview's); the stencil clears per frame.
 */
export const paintOnce = (ref: number) => ({
  stencilWrite: true,
  stencilRef: ref,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp,
});

/** A stencil number for the `n`th fill drawn, cycling through the ones regions may use. */
export const fillRef = (n: number) => (n % 254) + 1;

/**
 * The mesh's own colour on the ground plane, averaged per `cell` yalms over the triangles whose
 * middle lies in each cell. Read once, while the mesh carries its material colours.
 */
export function groundColours(mesh: THREE.Mesh, cell = 4) {
  const pos = mesh.geometry.getAttribute("position");
  const color = mesh.geometry.getAttribute("color");
  const sums = new Map<string, [number, number, number, number]>();
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const x = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const z = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    const sum = sums.get(key) ?? [0, 0, 0, 0];
    sum[0] += color.getX(t);
    sum[1] += color.getY(t);
    sum[2] += color.getZ(t);
    sum[3]++;
    sums.set(key, sum);
  }
  return { cell, sums };
}

/** The average ground colour inside a ring, as HSL, from `groundColours`; undefined if none. */
export function groundUnder(ground: ReturnType<typeof groundColours>, ring: readonly (readonly number[])[], inside: (x: number, z: number) => boolean) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z] of ring) (minX = Math.min(minX, x), maxX = Math.max(maxX, x), minZ = Math.min(minZ, z), maxZ = Math.max(maxZ, z));
  const { cell, sums } = ground;
  let r = 0, g = 0, b = 0, n = 0;
  for (let ix = Math.floor(minX / cell); ix <= Math.floor(maxX / cell); ix++) {
    for (let iz = Math.floor(minZ / cell); iz <= Math.floor(maxZ / cell); iz++) {
      const sum = sums.get(`${ix},${iz}`);
      if (!sum || !inside((ix + 0.5) * cell, (iz + 0.5) * cell)) continue;
      (r += sum[0], g += sum[1], b += sum[2], n += sum[3]);
    }
  }
  if (!n) return undefined;
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(r / n, g / n, b / n).getHSL(hsl);
  return hsl;
}

/** How many world units one screen pixel covers at the orbit target, for sizing things in pixels. */
export function worldPerPixel(camera: THREE.PerspectiveCamera, target: THREE.Vector3, canvasHeight: number) {
  return (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(target)) / canvasHeight;
}
