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
  (mesh.material as THREE.MeshBasicMaterial).color.setScalar(brightness);
  scene.add(mesh);
  return {
    mesh,
    prep,
    dispose: () => {
      scene.remove(mesh);
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

/** How many world units one screen pixel covers at the orbit target, for sizing things in pixels. */
export function worldPerPixel(camera: THREE.PerspectiveCamera, target: THREE.Vector3, canvasHeight: number) {
  return (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(target)) / canvasHeight;
}
