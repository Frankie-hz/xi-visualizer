import * as THREE from "three";
import type { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { addMapControls, adjustCameraAspect, createMapCamera } from "./camera";
import { setupBaseScene } from "./scene";
import { cleanupNode } from "./util";

/** An extra canvas drawn from the same camera each frame, with a scene of its own. */
export interface ViewerPane {
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
}

export interface ViewerOptions {
  /** Defaults to a fresh {@link setupBaseScene}. Whoever passes one gives up ownership: dispose() cleans it. */
  scene?: THREE.Scene;
  /** Defaults to {@link createMapCamera}. NOT added to the scene, so anything handed to it is flipped -- see README. */
  camera?: THREE.PerspectiveCamera;
  /** Element the controls listen on. Defaults to the canvas; panes spanning several canvases pass the wrapper. */
  controlsElement?: HTMLElement;
  /** Keep the drawing buffer after the frame, so a screenshot can read the canvas back. Costs memory. */
  preserveDrawingBuffer?: boolean;
  /** A stencil buffer, which three.js no longer asks for by default. The region fills need it. */
  stencil?: boolean;
  /** Extra canvases sharing this camera and controls, so dragging one moves all of them. */
  panes?: ViewerPane[];
  /** Match the canvas backing store to its parent on window resize. Default true. */
  autoResize?: boolean;
  /** Before the frame is drawn. dt is seconds since the previous frame. Animation and per-frame uniforms go here. */
  onFrame?: (dt: number) => void;
  /** After the frame is drawn, when the camera matrices are current. HTML label placement goes here. */
  onAfterRender?: () => void;
}

export interface Viewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: MapControls;
  canvas: HTMLCanvasElement;
  /** Extra panes in the order they were given, each with the renderer driving it. */
  panes: (ViewerPane & { renderer: THREE.WebGLRenderer; })[];
  /** Stops the loop and releases everything: renderers, GL contexts, controls, scenes. Call exactly once. */
  dispose(): void;
}

/**
 * One WebGL viewer over a canvas: renderer, controls, resize handling, render loop and teardown.
 *
 * Plain DOM and three.js, no framework: a UI layer creates one when its canvas exists and calls
 * dispose() when it goes away. Everything that varies between viewers is a callback, so the
 * lifecycle -- and in particular the teardown, which is the part that bites -- lives in one place.
 */
export function createViewer(canvas: HTMLCanvasElement, options: ViewerOptions = {}): Viewer {
  const scene = options.scene ?? setupBaseScene();
  const camera = options.camera ?? createMapCamera();
  const gl = { antialias: true, alpha: true, preserveDrawingBuffer: options.preserveDrawingBuffer, stencil: options.stencil ?? false };

  const renderer = new THREE.WebGLRenderer({ canvas, ...gl });
  const panes = (options.panes ?? []).map(pane => ({
    ...pane,
    renderer: new THREE.WebGLRenderer({ canvas: pane.canvas, ...gl }),
  }));
  const controls = addMapControls(camera, options.controlsElement ?? canvas);

  const autoResize = options.autoResize ?? true;
  const resizeCanvas = () => {
    const rect = canvas.parentElement!.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  };
  if (autoResize) {
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
  }

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    controls.update(dt);
    options.onFrame?.(dt);
    // A hidden canvas measures 0x0, and an aspect of 0/0 is NaN, which poisons the projection
    // matrix for every frame after it. Nothing is visible at that size anyway, so skip the draw.
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      adjustCameraAspect(camera, canvas);
      renderer.render(scene, camera);
      for (const pane of panes) {
        pane.renderer.setSize(pane.canvas.clientWidth, pane.canvas.clientHeight, false);
        pane.renderer.render(pane.scene, camera);
      }
    }
    options.onAfterRender?.();
  });

  return {
    renderer,
    scene,
    camera,
    controls,
    canvas,
    panes,
    dispose() {
      if (autoResize) {
        window.removeEventListener("resize", resizeCanvas);
      }
      renderer.setAnimationLoop(null);
      for (const r of [renderer, ...panes.map(p => p.renderer)]) {
        r.dispose();
        // dispose() releases what three.js allocated, but leaves the WebGL context itself alive: the
        // canvas goes away, the context does not, and it holds its buffers on the GPU until the
        // browser eventually collects it. Swapping zones a dozen times reaches the limit a browser
        // keeps contexts for, and the only thing that frees them is restarting the browser.
        r.forceContextLoss();
      }
      controls.dispose();
      for (const s of [scene, ...panes.map(p => p.scene)]) {
        cleanupNode(s);
      }
    },
  };
}
