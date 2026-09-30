// @ts-ignore
import * as THREE from "three";
import Stats from "three/addons/libs/stats.module.js";

import { IoHelpCircle, IoSettings } from "solid-icons/io";
import { batch, createEffect, createMemo, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { createMutable, createStore, produce, SetStoreFunction, unwrap } from "solid-js/store";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { MapControls } from "three/examples/jsm/Addons.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { addMapControls, adjustCameraAspect, fitCameraToContents } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode, roundDecimals } from "../graphics/util";
import { ColorKind, colorMesh, createZoneMesh, getHitData, getMapId, markLineCollisions, prepareMeshData, RayHit } from "../graphics/ximesh";
import { ByZone, type ZoneData } from "../types";
import AreaMenu, { Area, centreOf, circleOf, circlePoints, deriveAreaYs as deriveAreaYRange, Point, rotateAbout } from "./area_menu";
import PathNodes from "./path_nodes";
import SelectionBox, { type SelectionBoxResult } from "./selection_box";
import { TargetInfo, ZoneInfoBox } from "./zone_info_box";
import { ZoneRayTestingBox } from "./zone_ray_testing_box";

// Add the extension functions
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ZoneDataProps {
  zoneData: ByZone<ZoneData>;
  sourceKey?: string;
  defaultSettings?: ZoneModelSettingsDefault;
}

interface ZoneModelSettings {
  showInfoBox: boolean;
  showNodeManager: boolean;
  showAreaManager: boolean;
  showRayTesting: boolean;
  colorKind: ColorKind;
}

type ZoneModelSettingsDefault = Partial<ZoneModelSettings>;

export type { ZoneData } from "../types";

const enum MenuPopup {
  None = 0,
  Settings = 1,
  Help = 2,
}

export default function ZoneModel(props: ZoneDataProps) {
  const [getMenuPopup, setMenuPopup] = createSignal<MenuPopup>(MenuPopup.None);

  const [getSelectionBox, setSelectionBox] = createSignal<SelectionBoxResult | undefined>();

  // General zone model settings
  const generalSettingsKey = props.sourceKey ? `xi-visualizer.settings.${props.sourceKey}` : "xi-visualizer.settings._any";
  const localStorageGeneralSettings: ZoneModelSettings = JSON.parse(localStorage.getItem(generalSettingsKey), (k, v) => {
    if (k == "colorKind") {
      return parseInt(v);
    } else {
      return v;
    }
  }) || {};

  const defaultGeneralSettings: ZoneModelSettings = {
    showInfoBox: false,
    showNodeManager: false,
    showAreaManager: false,
    showRayTesting: false,
    colorKind: ColorKind.Materials,
    ...props.defaultSettings,
  };

  // Update local storage on change
  const generalSettings = createMutable<ZoneModelSettings>({
    ...defaultGeneralSettings,
    ...localStorageGeneralSettings,
  });

  createEffect(() => {
    localStorage.setItem(generalSettingsKey, JSON.stringify(generalSettings));
  });

  // Zone signals and stores
  const zoneIds = Object.keys(props.zoneData);
  const startingZoneId = zoneIds[0] != "0" ? parseInt(zoneIds[0]) : (parseInt(zoneIds[1]) || 0);
  const [getSelectedZone, setSelectedZone] = createSignal<number>(startingZoneId);

  const scene = createMemo(() => {
    return setupBaseScene();
  });

  const camera = createMemo(() => {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
    camera.position.set(0, 1000, 0);
    camera.lookAt(0, 0, 0);
    return camera;
  });

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  // Prepare mesh data
  const prepMeshData = createMemo(() => {
    const preparedMeshesData = {};
    for (const zoneId in props.zoneData) {
      const zoneData = props.zoneData[zoneId];
      const preparedMeshData = prepareMeshData(zoneData.mesh);

      preparedMeshesData[zoneData.id] = preparedMeshData;
    }

    return preparedMeshesData;
  }, {});

  // Create zones
  const zoneMeshes = createMemo(() => {
    const zoneMeshes: { [zoneid: number]: THREE.Mesh; } = {};
    for (const zoneId in props.zoneData) {
      const zoneData = props.zoneData[zoneId];
      const prep = prepMeshData()[zoneId];
      const mesh = createZoneMesh(zoneData.id, zoneData.mesh, prep, unwrap(generalSettings).colorKind);
      mesh.visible = false;

      zoneMeshes[zoneData.id] = mesh;
      console.log("Adding zone", zoneId);
      scene().add(mesh);
    }

    onCleanup(() => {
      for (const zoneId in zoneMeshes) {
        console.log("Disposing zone", zoneId);
        const mesh = zoneMeshes[zoneId];
        scene().remove(mesh);
        cleanupNode(mesh);
      }
    });

    return zoneMeshes;
  }, {});

  // Show/hide zone meshes
  createEffect(() => {
    for (const zoneId in zoneMeshes()) {
      zoneMeshes()[zoneId].visible = parseInt(zoneId) == getSelectedZone();
    }
  });

  let canvasElement: HTMLCanvasElement;
  let labelRendererElement: HTMLDivElement;
  let coordLabelRef: HTMLDivElement;

  let hasMouseMovedSinceLast = false;

  const [getNeedsResize, setNeedsResize] = createSignal<boolean>(true);
  function resizeCanvas() {
    const parentRect = canvasElement.parentElement!.getBoundingClientRect();
    canvasElement.width = parentRect.width;
    canvasElement.height = parentRect.height;
    setNeedsResize(true);
  }

  const [controls, setControls] = createSignal<MapControls>();

  // Frame the zone we switched to. The camera otherwise stays where it was built, at (0, 1000, 0)
  // with a 30 degree field of view, which sees roughly 700x540 units around the origin. That only
  // happens to work for zones that are compact and centred there: Riverne - Site #A01 spans about
  // 1900 with its islands ringing an empty middle, so the fixed view landed on the void between
  // them and the zone looked like it had failed to load.
  //
  // Depends on controls() as well as the zone, because controls are only created in onMount, which
  // runs after this effect: without that the first zone opened would never be framed.
  createEffect(on([getSelectedZone, controls], ([zoneId, mapControls]) => {
    const mesh = zoneMeshes()[zoneId];
    if (!mesh || !mapControls) return;
    fitCameraToContents(camera(), mapControls, fn => fn(mesh));

    // The fit puts the widest zones measured (Western Altepa, Riverne) about 4000 out against a
    // far plane of 5000, so a wider one would sit behind it and draw nothing. Keep near and far
    // tight for the depth precision, and push far out only as far as this zone actually needs.
    const distance = camera().position.distanceTo(mapControls.target);
    const needed = distance * 1.5;
    if (camera().far < needed) {
      camera().far = needed;
      camera().updateProjectionMatrix();
    }
  }));

  onMount(() => {
    window.addEventListener("resize", resizeCanvas);

    canvasElement.addEventListener("mousemove", event => {
      const canvas = canvasElement;
      cameraMouse.x = (2 * event.offsetX) / canvas.offsetWidth - 1;
      cameraMouse.y = (-2 * event.offsetY) / canvas.offsetHeight + 1;
      screenMouse.x = event.offsetX;
      screenMouse.y = event.offsetY;
      hasMouseMovedSinceLast = true;
    });

    canvasElement.addEventListener("mouseout", event => {
      coordLabelRef.style.display = "none";
    });

    // Dragging out a trigger area rectangle. The corners are picked off the terrain rather than
    // read from screen pixels, so the rectangle stays where it was drawn when the camera is
    // orbited: a screen-space box is only the same thing while looking straight down.
    canvasElement.addEventListener("mousedown", event => {
      if (!generalSettings.showAreaManager || !getRectMode() || event.button !== 0 || dragVertex !== undefined) {
        return;
      }
      const point = pickGamePoint(event);
      if (!point) {
        return;
      }
      event.preventDefault();
      controls().enabled = false;

      rectAnchor = { x: point.x, z: point.z };
      dragPlaneY = -point.y;
      // Committing the area now means the existing draw effect renders the drag for free.
      setAreas(areas.length, { triggerShape: "cuboid", polygon: rectCorners(rectAnchor, rectAnchor) });
      rectIdx = areas.length - 1;
      batch(() => {
        setSelectedAreaIdx(rectIdx);
        setSelectedSubPolygonIdx(undefined);
        setSelectedVertexIdx(undefined);
      });
    });

    window.addEventListener("mousemove", event => {
      if (dragVertex === undefined) {
        return;
      }
      const point = pickGamePoint(event, dragPlaneY);
      if (point) {
        moveVertex(dragVertex, point.x, point.z);
      }
    });

    canvasElement.addEventListener("mousemove", event => {
      if (rectAnchor === undefined || rectIdx === undefined) {
        return;
      }
      const point = pickGamePoint(event, dragPlaneY);
      if (point) {
        setAreas(rectIdx, "polygon", rectCorners(rectAnchor, point));
      }
    });

    // On window, so releasing outside the canvas still finishes the rectangle.
    window.addEventListener("mouseup", () => {
      if (dragVertex !== undefined) {
        dragVertex = undefined;
        dragPlaneY = undefined;
        if (controls()) {
          controls().enabled = true;
        }
      }
      if (rectIdx === undefined) {
        return;
      }
      const idx = rectIdx;
      rectAnchor = undefined;
      rectIdx = undefined;
      dragPlaneY = undefined;
      if (controls()) {
        controls().enabled = true;
      }

      const polygon = areas[idx]?.polygon ?? [];
      const xs = polygon.map(p => p.x);
      const zs = polygon.map(p => p.z);
      // A click that never became a drag would otherwise leave a zero-width area behind.
      if (Math.max(...xs) - Math.min(...xs) < 1 || Math.max(...zs) - Math.min(...zs) < 1) {
        batch(() => {
          setAreas(produce<Area[]>(list => {
            list.splice(idx, 1);
          }));
          setSelectedAreaIdx(undefined);
        });
        return;
      }

      // Seed the height band off the ground under the corners and the middle. It is a starting
      // point, not an answer: the y inputs are there because only the author knows how much
      // headroom the trigger wants.
      const zoneMesh = zoneMeshes()[getSelectedZone()];
      if (zoneMesh) {
        const range = { yMin: Infinity, yMax: -Infinity };
        const origin = new THREE.Vector3(0, 1000, 0);
        const direction = new THREE.Vector3(0, -1, 0);
        const middle = {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          z: (Math.min(...zs) + Math.max(...zs)) / 2,
        };
        for (const point of [...polygon, middle]) {
          updateYRangeForPoint(range, point, zoneMesh, origin, direction);
        }
        if (range.yMin !== Infinity) {
          // Sampled ys are in display space, so they flip back the way the corners did.
          batch(() => {
            setAreas(idx, "yMin", Math.floor(-range.yMax) - 5);
            setAreas(idx, "yMax", Math.ceil(-range.yMin) + 10);
          });
        }
      }
    });

    // Area details clicking
    canvasElement.addEventListener("click", event => {
      if (!generalSettings.showAreaManager || !getShowAreaDetails() || !event.ctrlKey) {
        return;
      }

      const hits = castRayOntoMesh();
      if (!hits) {
        return;
      }
      const hit = hits[0];

      setShowAreaDetails(true);

      // Add a new polygon if none is selected
      if (getSelectedAreaIdx() == undefined) {
        setAreas(areas.length, { polygon: [] });
        setSelectedAreaIdx(areas.length - 1);
      }

      const area = areas[getSelectedAreaIdx()];
      const polygon = area.polygon;

      const newVertex = { x: Math.round(hit.x), z: Math.round(-hit.z) };

      let setPoints: SetStoreFunction<Point[]>;
      let points: Point[];
      if (getSelectedSubPolygonIdx() !== undefined) {
        setPoints = setAreas.bind(null, getSelectedAreaIdx(), "holes", getSelectedSubPolygonIdx());
        points = area.holes?.[getSelectedSubPolygonIdx()];
      } else {
        setPoints = setAreas.bind(null, getSelectedAreaIdx(), "polygon");
        points = polygon;
      }

      if (getSelectedVertexIdx() !== undefined) {
        // If there's a selected vertex, add the new vertex right after it
        setPoints(produce<Point[]>(vertices => {
          vertices.splice(getSelectedVertexIdx() + 1, 0, newVertex);
          return vertices;
        }));
        setSelectedVertexIdx(getSelectedVertexIdx() + 1);
      } else {
        // Else just add the new vertex at the end
        setPoints(points.length, newVertex);
        setSelectedVertexIdx(points.length - 1);
      }
    });

    // Ray clicking
    canvasElement.addEventListener("click", event => {
      if (!generalSettings.showRayTesting || getShowAreaDetails() || !event.ctrlKey && !event.shiftKey) {
        return;
      }

      raycaster.firstHitOnly = false;
      const hits = castRayOntoMesh();
      raycaster.firstHitOnly = true;

      if (!hits || hits.length == 0) {
        return;
      }

      const hitsData = getHitData(zoneMeshes()[getSelectedZone()], props.zoneData[getSelectedZone()].mesh, prepMeshData()[getSelectedZone()], hits);

      for (let i = 0; i < hitsData.length; i++) {
        const hitData = hitsData[i];
        // console.log(`======================= Hit ${i} ======================= `)
        // console.log("Hit", hitData.hit);
        // console.log("Block", hitData.block);
        // console.log("Placement", hitData.placement);
        // console.log("Material", hitData.material);
      }

      const firstHit = hits[0];
      const markerPos = new THREE.Vector3(roundDecimals(firstHit.x, 3), roundDecimals(-firstHit.y - 2.25, 3), roundDecimals(-firstHit.z, 3));

      if (event.ctrlKey) {
        setStartPos(markerPos);
      } else if (event.shiftKey) {
        setEndPos(markerPos);
      }
    });

    setControls(addMapControls(camera(), canvasElement));

    const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
    const labelRenderer = new CSS2DRenderer({ element: labelRendererElement });

    renderer.setAnimationLoop(() => animate(renderer, labelRenderer));

    // Handle used by scripts/shot.mjs `points` to drop markers in and frame the camera headlessly.
    (window as any).__zoneView = { THREE, scene: scene(), camera: camera(), controls: controls(), renderer };

    onCleanup(() => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      // dispose() releases what three.js allocated, but leaves the WebGL context itself alive: the
      // canvas goes away, the context does not, and it holds its buffers on the GPU until the
      // browser eventually collects it. Swapping zones a dozen times reaches the limit a browser
      // keeps contexts for, and the only thing that frees them is restarting the browser.
      renderer.forceContextLoss();
      delete (window as any).__zoneView;
    });
  });

  onCleanup(() => {
    window.removeEventListener("resize", resizeCanvas);
    cleanupNode(scene());
    if (controls()) {
      controls().dispose();
      setControls(undefined);
    }
    scene().clear();
    camera().clear();
  });

  const clock = new THREE.Clock();
  const stats = new Stats();
  stats.dom.style.position = "absolute";

  const cameraMouse = new THREE.Vector2(1, 1);
  const screenMouse = new THREE.Vector2(1, 1);

  function updatePosLabel() {
    const hits = castRayOntoMesh();
    if (hits) {
      const hitsData = getHitData(zoneMeshes()[getSelectedZone()], props.zoneData[getSelectedZone()].mesh, prepMeshData()[getSelectedZone()], hits);
      const hitData = hitsData[0];
      setTargetInfo({
        x: hitData.hit.x,
        y: hitData.hit.y * -1,
        z: hitData.hit.z * -1,
        mapId: getMapId(hitData.placement),
        material: hitData.material,
        cellIdx: hitData.cellIdx,
        cellEntryIdx: hitData.entryIdx,
        block: hitData.block,
        placement: hitData.placement,
      });

      coordLabelRef.textContent = `${hitData.hit.x.toFixed(1)}, ${(hitData.hit.y * -1).toFixed(1)}, ${(hitData.hit.z * -1).toFixed(1)} `;
      coordLabelRef.style.left = `${screenMouse.x + 20}px`;
      coordLabelRef.style.top = `${screenMouse.y - 20}px`;
      coordLabelRef.style.display = "block";
    } else {
      coordLabelRef.style.display = "none";
      setTargetInfo(undefined);
    }
  }

  function castRayOntoMesh(): RayHit[] | undefined {
    raycaster.setFromCamera(cameraMouse, camera());
    const intersections = raycaster.intersectObjects([zoneMeshes()[getSelectedZone()]], false);
    if (intersections.length == 0) {
      return;
    }

    let result: RayHit[] = [];
    for (const int of intersections) {
      const p = int.point;
      const face = int.face ? { a: int.face.a, b: int.face.b, c: int.face.c } : undefined;
      result.push({
        x: p.x,
        y: p.y,
        z: p.z,
        object: int.object,
        index: int.index!,
        faceIndex: int.faceIndex!,
        face,
      });
    }
    return result;
  }

  function getFirstYForPoint(
    point: Point,
    zoneMesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): number | undefined {
    origin.x = point.x;
    origin.z = -point.z;
    raycaster.set(origin, direction);
    const intersections = raycaster.intersectObject(zoneMesh, false);
    if (intersections.length == 0) {
      return undefined;
    }
    return intersections[0].point.y;
  }

  /**
   * Where the pointer is, in game coordinates. The scene draws with scale (1, -1, -1), so a hit
   * comes back flipped on y and z and has to be put back before it is stored or written out.
   */
  function pickGamePoint(event: MouseEvent, planeY?: number): { x: number; y: number; z: number; } | undefined {
    // Off the canvas rect rather than offsetX/offsetY, because a vertex drag keeps tracking on
    // window once the pointer leaves the handle it started on.
    const rect = canvasElement.getBoundingClientRect();
    cameraMouse.x = (2 * (event.clientX - rect.left)) / rect.width - 1;
    cameraMouse.y = (-2 * (event.clientY - rect.top)) / rect.height + 1;

    const hits = castRayOntoMesh();
    if (hits?.length) {
      const hit = hits[0];
      return { x: Math.round(hit.x), y: Math.round(-hit.y), z: Math.round(-hit.z) };
    }

    // Nothing under the pointer. A trigger area routinely reaches past the edge of the mesh or
    // over a gap in it, and a corner that stops moving there cannot be placed at all, so fall back
    // to the flat plane the drag started on.
    if (planeY === undefined) {
      return undefined;
    }
    raycaster.setFromCamera(cameraMouse, camera());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const onPlane = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, onPlane)) {
      return undefined;
    }
    return { x: Math.round(onPlane.x), y: Math.round(-onPlane.y), z: Math.round(-onPlane.z) };
  }

  /**
   * Move one vertex of the selected area, keeping a rectangle a rectangle.
   *
   * A corner of a four-point box shares its x with one neighbour and its z with the other, so
   * dragging it has to carry those two along or the box turns into a quadrilateral. Matching on
   * the shared coordinate rather than on index means it does not care which way round the corners
   * were drawn, and a shape that is not an axis-aligned box moves the one vertex, as before.
   */
  function moveVertex(index: number, x: number, z: number) {
    const areaIdx = getSelectedAreaIdx();
    if (areaIdx === undefined) {
      return;
    }
    const subIdx = getSelectedSubPolygonIdx();
    const points = subIdx !== undefined ? areas[areaIdx].holes?.[subIdx] : areas[areaIdx].polygon;
    const from = points?.[index];
    if (!from) {
      return;
    }

    // A circle has no corners to drag, only a radius: pulling any handle resizes it about its
    // centre, rather than denting the ring and leaving the exported radius a guess.
    if (subIdx === undefined && areas[areaIdx].triggerShape === "cylinder") {
      const c = circleOf(points);
      const radius = Math.hypot(x - c.cx, z - c.cz);
      if (radius > 0.5) {
        setAreas(areaIdx, "polygon", circlePoints(c.cx, c.cz, radius, points.length));
      }
      return;
    }

    // A turned box is only a rectangle in its own frame, so the corner rule has to be applied
    // there: un-turn, move, turn back about the same centre. Rotation is rigid, so the moved box
    // still un-turns cleanly about its new centre when it is written out.
    const rotation = areas[areaIdx].triggerRotation ?? 0;
    if (subIdx === undefined && points.length === 4 && rotation) {
      const { cx, cz } = centreOf(points);
      const frame = points.map(p => rotateAbout(p, cx, cz, -rotation));
      const target = rotateAbout({ x, z }, cx, cz, -rotation);
      const moved = frame.map(p => ({ x: p.x, z: p.z }));
      moved[index] = target;
      for (const j of [(index + 1) % 4, (index + 3) % 4]) {
        // Compared with a tolerance rather than for equality: these came back through a rotation.
        if (Math.abs(frame[j].x - frame[index].x) < 1e-6) {
          moved[j].x = target.x;
        }
        if (Math.abs(frame[j].z - frame[index].z) < 1e-6) {
          moved[j].z = target.z;
        }
      }
      setAreas(areaIdx, "polygon", moved.map(p => rotateAbout(p, cx, cz, rotation)));
      return;
    }

    const next = points.map(p => ({ x: p.x, z: p.z }));
    next[index] = { x, z };
    if (points.length === 4) {
      for (const j of [(index + 1) % 4, (index + 3) % 4]) {
        if (points[j].x === from.x) {
          next[j].x = x;
        }
        if (points[j].z === from.z) {
          next[j].z = z;
        }
      }
    }

    if (subIdx !== undefined) {
      setAreas(areaIdx, "holes", subIdx, next);
    } else {
      setAreas(areaIdx, "polygon", next);
    }
  }

  /** The four corners of the axis-aligned rectangle spanned by two opposite points. */
  function rectCorners(a: Point, b: Point): Point[] {
    return [{ x: a.x, z: a.z }, { x: b.x, z: a.z }, { x: b.x, z: b.z }, { x: a.x, z: b.z }];
  }

  function updateYRangeForPoint(
    range: { yMin: number; yMax: number; },
    point: Point,
    zoneMesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ) {
    origin.x = point.x;
    origin.z = -point.z;
    raycaster.set(origin, direction);
    const intersections = raycaster.intersectObject(zoneMesh, false);
    for (const intersection of intersections) {
      const y = intersection.point.y;
      if (y < range.yMin) {
        range.yMin = y;
      }
      if (y > range.yMax) {
        range.yMax = y;
      }
    }
  }

  function animate(renderer: THREE.WebGLRenderer, labelRenderer: CSS2DRenderer) {
    stats.update();

    const delta = clock.getDelta();
    controls()?.update(delta);

    if (getNeedsResize()) {
      const canvas = canvasElement;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
      adjustCameraAspect(camera(), canvasElement);
      setNeedsResize(false);
    }

    if (hasMouseMovedSinceLast) {
      hasMouseMovedSinceLast = false;
      updatePosLabel();
    }

    renderer.render(scene(), camera());
    labelRenderer.render(scene(), camera());
  }

  const [areas, setAreas] = createStore<Area[]>([]);
  const [getSelectedAreaIdx, setSelectedAreaIdx] = createSignal<number | undefined>();
  const [getSelectedSubPolygonIdx, setSelectedSubPolygonIdx] = createSignal<number | undefined>();
  const [getSelectedVertexIdx, setSelectedVertexIdx] = createSignal<number | undefined>();
  const [getShowAreaDetails, setShowAreaDetails] = createSignal<boolean>(false);

  // Dragging out a trigger area. Plain left-drag, because ctrl already adds a vertex and shift is
  // the node marquee, so this needs a mode of its own rather than another modifier.
  const [getRectMode, setRectMode] = createSignal<boolean>(false);
  let rectAnchor: Point | undefined;
  let rectIdx: number | undefined;
  let dragVertex: number | undefined;
  /** Display-space height the current drag fell back to when the pointer left the mesh. */
  let dragPlaneY: number | undefined;

  const areaMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.5,
    color: 0xFCAA58,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const selectedAreaMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.6,
    color: 0xFCF63C,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Draw areas
  createEffect(() => {
    const zoneMesh = zoneMeshes()[getSelectedZone()];
    if (!zoneMesh) {
      return;
    }

    let meshes: THREE.Mesh[] = [];
    let elements: Element[] = [];
    let labels: CSS2DObject[] = [];

    let origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);

    for (let i = 0; i < areas.length; i++) {
      const area = areas[i];
      if (area.hidden || area.polygon.length < 3) {
        continue;
      }

      // Create the polygon shape
      const shape = new THREE.Shape(area.polygon.map(p => new THREE.Vector2(p.x, p.z)));
      if (area.holes?.length > 0) {
        for (const hole of area.holes) {
          if (hole.length < 3) {
            continue;
          }
          shape.holes.push(new THREE.Shape(hole.map(p => new THREE.Vector2(p.x, p.z))));
        }
      }

      // Determine where the area should be displayed on the Y-axis
      const areaYRange = deriveAreaYRange(area);

      let visualYRange = { yMax: -areaYRange.yMin, yMin: -areaYRange.yMax };
      if (areaYRange.unlimited) {
        visualYRange.yMin = 1000;
        visualYRange.yMax = -1000;
        origin.y = -areaYRange.yMin;

        for (const p of area.polygon) {
          updateYRangeForPoint(visualYRange, p, zoneMesh, origin, direction);
        }
        if (area.holes) {
          for (const hole of area.holes) {
            for (const p of hole) {
              updateYRangeForPoint(visualYRange, p, zoneMesh, origin, direction);
            }
          }
        }

        if (visualYRange.yMin == 1000) {
          // No intersections, so lower it to some default min max
          visualYRange.yMin = -100;
          visualYRange.yMax = 100;
        } else {
          visualYRange.yMin -= 10;
          visualYRange.yMax += 10;
        }
      }

      const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(visualYRange.yMax - visualYRange.yMin), bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, -visualYRange.yMin, 0);
      geo.computeBoundingBox();

      const mat = getSelectedAreaIdx() == i ? selectedAreaMat : areaMat;
      const areaMesh = new THREE.Mesh(geo, mat);

      areaMesh.layers.enableAll();

      if (getSelectedAreaIdx() !== i) {
        // Add area labels for non-selected areas
        const div = document.createElement("div");
        div.textContent = `Area ${i + 1} `;
        div.className = "vertex-label noselect pointer-events-auto cursor-pointer text-sm font-mono";
        div.onclick = () => {
          setSelectedAreaIdx(i);
        };
        elements.push(div);

        const label = new CSS2DObject(div);
        const box = geo.boundingBox;

        label.position.set(
          box.min.x + (box.max.x - box.min.x) / 2,
          box.min.y + (box.max.y - box.min.y) / 2 - 10,
          box.min.z + (box.max.z - box.min.z) / 2,
        );

        // If possible, place the area label according to the y position of the underlying mesh
        origin.y = -areaYRange.yMin;
        const y = getFirstYForPoint({ x: label.position.x, z: label.position.z }, zoneMesh, origin, direction);
        if (y !== undefined) {
          label.position.y = -y - 10;
        }

        areaMesh.add(label);
        label.layers.set(0);
        labels.push(label);
      }

      meshes.push(areaMesh);
      scene().add(areaMesh);
    }

    onCleanup(() => {
      for (const label of labels) {
        cleanupNode(label);
      }
      for (const el of elements) {
        el.remove();
      }
      for (const mesh of meshes) {
        cleanupNode(mesh);
        scene().remove(mesh);
      }
    });
  });

  // Draw current area handles
  createEffect(() => {
    if (getSelectedAreaIdx() === undefined) {
      return;
    }

    let meshes: THREE.Mesh[] = [];
    let elements: Element[] = [];
    let labels: CSS2DObject[] = [];

    const area = areas[getSelectedAreaIdx()];
    if (area.hidden) {
      return;
    }

    const zoneMesh = zoneMeshes()[getSelectedZone()];
    if (!zoneMesh) {
      return;
    }

    const areaYRange = deriveAreaYRange(area);
    let origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);
    origin.y = -areaYRange.yMin;

    // Default Y to place the handles at, if they do not intersect the zone mesh
    let defaultY = 0;
    if (!areaYRange.unlimited) {
      if (areaYRange.yMax > 1000) {
        defaultY = areaYRange.yMin;
      } else if (areaYRange.yMin < -1000) {
        defaultY = areaYRange.yMax;
      } else {
        defaultY = (areaYRange.yMax - areaYRange.yMin) / 2 + areaYRange.yMin;
      }
    }

    const points = getSelectedSubPolygonIdx() !== undefined ? area.holes[getSelectedSubPolygonIdx()] : area.polygon;

    // Handles
    for (let i = 0; i < points.length; i++) {
      const pos = points[i];
      const geo = new THREE.SphereGeometry(1);
      const mat = new THREE.MeshBasicMaterial({ color: 0xFF7F00 });
      const mesh = new THREE.Mesh(geo, mat);

      const y = getFirstYForPoint({ x: pos.x, z: pos.z }, zoneMesh, origin, direction) ?? -defaultY;
      mesh.position.set(pos.x, -y, pos.z);

      mesh.layers.enableAll();

      const div = document.createElement("div");
      div.textContent = String.fromCharCode("A".charCodeAt(0) + i);
      div.className = "vertex-label noselect pointer-events-auto cursor-move text-sm font-mono";
      if (getSelectedVertexIdx() == i) {
        div.className += " font-bold bg-blue-800 underline";
      } else {
        div.onclick = () => {
          setSelectedVertexIdx(i);
        };
      }

      // Drag the handle to move the corner. The label carries it rather than the sphere, which is
      // radius 1 in a zone a thousand units across and so is not a target anyone can hit.
      div.onmousedown = event => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dragVertex = i;
        dragPlaneY = mesh.position.y;
        setSelectedVertexIdx(i);
        if (controls()) {
          controls().enabled = false;
        }
      };
      elements.push(div);

      const label = new CSS2DObject(div);
      label.position.set(0, -5, 0);
      mesh.add(label);
      label.layers.set(0);
      labels.push(label);

      meshes.push(mesh);
      scene().add(mesh);
    }

    onCleanup(() => {
      for (const label of labels) {
        cleanupNode(label);
      }
      for (const el of elements) {
        el.remove();
      }
      for (const mesh of meshes) {
        cleanupNode(mesh);
        scene().remove(mesh);
      }
    });
  });

  const [getStartPos, setStartPos] = createSignal<THREE.Vector3 | undefined>();
  const [getEndPos, setEndPos] = createSignal<THREE.Vector3 | undefined>();

  const [getTargetInfo, setTargetInfo] = createSignal<TargetInfo | undefined>();

  // Start marker mesh
  createEffect(on(getStartPos, (pos?: THREE.Vector3, _prevPos?: THREE.Vector3, prevMesh?: THREE.Mesh) => {
    if (!pos) {
      if (prevMesh) {
        onCleanup(() => {
          scene().remove(prevMesh);
          cleanupNode(prevMesh);
        });
      }
      return;
    }

    let mesh = prevMesh;
    if (!mesh) {
      const geo = new THREE.SphereGeometry(0.5);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 1, 0),
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.visible = true;
      scene().add(mesh);
    }

    mesh.position.copy(pos);

    return mesh;
  }));

  // End marker mesh
  createEffect(on(getEndPos, (pos?: THREE.Vector3, _prevPos?: THREE.Vector3, prevMesh?: THREE.Mesh) => {
    if (!pos) {
      if (prevMesh) {
        onCleanup(() => {
          scene().remove(prevMesh);
          cleanupNode(prevMesh);
        });
      }
      return;
    }

    let mesh = prevMesh;
    if (!mesh) {
      const geo = new THREE.SphereGeometry(0.5);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 0, 1),
      });
      mesh = new THREE.Mesh(geo, mat);
      scene().add(mesh);
    }

    mesh.position.copy(pos);

    return mesh;
  }));

  // Line between markers
  createEffect(on([getStartPos, getEndPos], (
    value: [THREE.Vector3 | undefined, THREE.Vector3 | undefined],
    _prevValue?: [THREE.Vector3 | undefined, THREE.Vector3 | undefined],
    prevLine?: THREE.Line,
  ) => {
    if (!value[0] || !value[1]) {
      if (prevLine) {
        onCleanup(() => {
          scene().remove(prevLine);
          cleanupNode(prevLine);
        });
      }
      return;
    }

    const mesh = zoneMeshes()[getSelectedZone()];
    if (!mesh) {
      return;
    }

    let line = prevLine;
    if (!line) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(2 * 3);
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(1, 0, 0),
        linewidth: 1,
        depthTest: true,
      });
      line = new THREE.Line(geo, mat);
      scene().add(line);
    }

    const positions = line.geometry.attributes.position;
    positions.array.set(value[0].toArray(), 0);
    positions.array.set(value[1].toArray(), 3);
    positions.needsUpdate = true;

    // Recompute box and sphere to ensure the new position doesn't get culled from the camera
    line.geometry.computeBoundingBox();
    line.geometry.computeBoundingSphere();

    markLineCollisions(mesh, props.zoneData[getSelectedZone()].mesh, prepMeshData()![getSelectedZone()], value[0], value[1]);

    return line;
  }));

  createEffect(on(() => generalSettings.colorKind, colorKind => {
    const meshes = zoneMeshes();
    const prep = prepMeshData();
    for (const zoneId of Object.keys(meshes)) {
      const mesh = meshes[zoneId];
      colorMesh(mesh, prep[zoneId]!, colorKind);
    }
  }));

  const toggleButton = (text: string, setter: (b: boolean) => any, getter: () => boolean) => {
    return (
      <label
        class="inline-flex items-center cursor-pointer select-none"
        onClick={e => {
          setter(!getter());
          e.preventDefault();
        }}
      >
        <input type="checkbox" class="sr-only peer" checked={getter()} />
        <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600 dark:peer-checked:bg-blue-600">
        </div>
        <span class="ms-1 text-sm font-medium">{text}</span>
      </label>
    );
  };

  const settingsMenu = (
    <div class="pointer-events-auto cursor-pointer bg-black bg-opacity-80 p-2 rounded-tr text-sm flex flex-col gap-2">
      <div class="flex flex-row items-baseline">
        <label for="color-select">Coloring:</label>
        <select
          id="color-select"
          value={generalSettings.colorKind}
          onChange={ev => {
            generalSettings.colorKind = parseInt(ev.target.value);
          }}
        >
          <option value={ColorKind.None}>None</option>
          <option value={ColorKind.Barriers}>Barriers</option>
          <option value={ColorKind.Materials}>Materials</option>
          <option value={ColorKind.Maps}>Map</option>
          <option value={ColorKind.IsRoofed}>Roofed</option>
        </select>
      </div>

      {toggleButton("Node Manager", v => {
        generalSettings.showNodeManager = v;
      }, () => generalSettings.showNodeManager)}

      {toggleButton("Area Manager", v => {
        generalSettings.showAreaManager = v;
      }, () => generalSettings.showAreaManager)}

      {toggleButton("Info Box", v => {
        generalSettings.showInfoBox = v;
      }, () => generalSettings.showInfoBox)}

      {toggleButton("Ray Testing", v => {
        generalSettings.showRayTesting = v;
      }, () => generalSettings.showRayTesting)}

      <button
        onClick={() => {
          for (const key in defaultGeneralSettings) {
            generalSettings[key] = defaultGeneralSettings[key];
          }
          localStorage.removeItem(generalSettingsKey);
        }}
      >
        Reset settings
      </button>

      <button onClick={() => setMenuPopup(MenuPopup.None)}>Close settings</button>
    </div>
  );

  const helpMenu = (
    <div class="pointer-events-auto cursor-pointer bg-black bg-opacity-80 p-2 rounded-tr text-sm" onClick={() => setMenuPopup(MenuPopup.None)}>
      Click this to hide it again.
      <ul class="list-disc list-inside">
        <li>
          <b>Move/rotate camera:</b> Left/right-click and drag
        </li>
        <li>
          <b>Area editing:</b> Most of the contents of the Area Manager can be clicked/edited.
        </li>
        <li>
          <b>Add a new area node:</b>{" "}
          With the Area Manager expanded: CTRL + left-click. If an existing node is selected, the new one will be inserted after it. While having a node
          selected, you can also press SHIFT + N to create a copy.
        </li>
        <li>
          <b>Select a node:</b> Select a node by either clicking it in the world, or on it in the Area Manager.
        </li>
        <li>
          <b>Move a node:</b>{" "}
          Select the node, then hold SHIFT + arrow keys to move it along the X- and/or Z-axis. Hold CTRL to move it faster. The coordinates can also be edited
          directly in the Area Manager.
        </li>
        <li>
          <b>Area to Lua:</b> Click the copy button next to an area in the Area Manager to get Lua code defining it into your clipboard.
        </li>
        <li>
          <b>Lua to areas:</b> Paste text containing Lua code that defines the areas (i.e. a zone Setup.lua file)
        </li>
      </ul>
    </div>
  );

  return (
    <div>
      <div class="relative" style={{ height: "70vh" }}>
        <canvas tabIndex={0} class="block w-full h-full outline-none" ref={canvasElement}>
        </canvas>

        <div
          class="absolute hidden p-1 text-white bg-black pointer-events-none rounded font-mono opacity-70 text-sm noselect"
          ref={coordLabelRef}
        >
        </div>
        <div
          class="absolute top-0 pointer-events-none"
          ref={labelRendererElement}
        >
        </div>

        <SelectionBox
          controls={controls()}
          canvasElement={canvasElement}
          outputSelectionRect={res => {
            setSelectionBox(res);
          }}
        >
        </SelectionBox>

        {/* Node Manager */}
        <Show when={generalSettings.showNodeManager}>
          <PathNodes
            scene={scene()}
            camera={camera()}
            canvasElement={canvasElement}
            selectionBox={getSelectionBox()}
            zoneMesh={zoneMeshes()[getSelectedZone()]}
            zoneId={getSelectedZone()}
          >
          </PathNodes>
        </Show>

        {/* Area Manager */}
        <Show when={generalSettings.showAreaManager}>
          <AreaMenu
            showDetails={getShowAreaDetails()}
            setShowDetails={setShowAreaDetails}
            areas={areas}
            setAreas={setAreas}
            selectedAreaIdx={getSelectedAreaIdx()}
            setSelectedAreaIdx={setSelectedAreaIdx}
            selectedSubPolygonIdx={getSelectedSubPolygonIdx()}
            setSelectedSubPolygonIdx={setSelectedSubPolygonIdx}
            selectedVertexIdx={getSelectedVertexIdx()}
            setSelectedVertexIdx={setSelectedVertexIdx}
            rectMode={getRectMode()}
            setRectMode={on => {
              setRectMode(on);
              // Leaving the mode mid-drag would otherwise strand the camera disabled.
              if (!on && controls()) {
                controls().enabled = true;
              }
            }}
          >
          </AreaMenu>
        </Show>

        {/* Info box */}
        <Show when={generalSettings.showInfoBox}>
          <ZoneInfoBox targetInfo={getTargetInfo()}></ZoneInfoBox>
        </Show>

        {/* Ray testing */}
        <Show when={generalSettings.showRayTesting}>
          <ZoneRayTestingBox
            getStartPos={getStartPos}
            setStartPos={setStartPos}
            getEndPos={getEndPos}
            setEndPos={setEndPos}
          >
          </ZoneRayTestingBox>
        </Show>

        {/* Performance stats */}
        <Show when={getMenuPopup() == MenuPopup.Settings}>
          <div class="absolute top-0 left-0 flex flex-row w-full">
            {import.meta.env.DEV ? stats.dom : undefined}
          </div>
        </Show>

        {/* Settings and help menu */}
        <div class="absolute bottom-0 left-0 pointer-events-none flex flex-row" style={{ width: "40%" }}>
          <Switch>
            <Match when={getMenuPopup() == MenuPopup.None}>
              <div class="pointer-events-auto cursor-pointer p-1" onClick={() => setMenuPopup(MenuPopup.Settings)}>
                <IoSettings size={20} title="Settings"></IoSettings>
              </div>
              <div class="pointer-events-auto cursor-pointer p-1" onClick={() => setMenuPopup(MenuPopup.Help)}>
                <IoHelpCircle size={20} title="Mouse and keyboard help"></IoHelpCircle>
              </div>
            </Match>
            <Match when={getMenuPopup() == MenuPopup.Settings}>{settingsMenu}</Match>
            <Match when={getMenuPopup() == MenuPopup.Help}>{helpMenu}</Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
