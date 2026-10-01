import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";

/**
 * The camera every zone viewer starts from: overhead, looking straight down at the origin.
 *
 * It is deliberately NOT part of the scene graph, so it does not inherit the scene's (1, -1, -1)
 * scale. Positions and targets handed to it are flipped -- see src/graphics/README.md.
 */
export function createMapCamera(far = 5000): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, far);
  camera.position.set(0, 500, 0);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function adjustCameraAspect(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
}

export function fitCameraToContents(camera: THREE.PerspectiveCamera, controls: MapControls, objectIter: (fn: (obj: THREE.Object3D) => any) => any) {
  const box = new THREE.Box3();
  let matrix = new THREE.Matrix4();
  let vec = new THREE.Vector3();

  // Loop through all children in the scene
  objectIter(object => {
    if (object instanceof THREE.InstancedMesh) {
      // Compute mesh bounding box
      for (let i = 0; i < object.count; i++) {
        matrix.fromArray(object.instanceMatrix.array, i * 16);
        vec.setFromMatrixPosition(matrix);

        // Correct for flipped Z-axis and Y-axis of FFXI
        vec.z = -vec.z;
        vec.y = -vec.y;
        box.expandByPoint(vec);
      }
    } else if (object instanceof THREE.Object3D) {
      box.expandByObject(object);
    }
  });

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();

  box.getCenter(center);
  box.getSize(size);

  if (size.length() == 0) {
    return;
  }

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);

  let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
  cameraZ *= 1.1;

  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);

  const newPosition = new THREE.Vector3().copy(center).addScaledVector(direction, -cameraZ);

  camera.position.copy(newPosition);

  controls.target.copy(center);
  controls.update();
}

export function addMapControls(camera: THREE.Camera, element?: HTMLElement) {
  return new MapControls(camera, element);
}
