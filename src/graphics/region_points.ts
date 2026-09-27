import * as THREE from "three";

// The point clouds the editor draws are all one draw call each, so what each dot looks like lives
// in a shader rather than in a mesh per dot. Colours are deliberately unshared: cyan is a roam
// trail, white a spawn, amber the replay head, violet a route, and a region's own hue its handles.

const POINT_VERTEX = `
  uniform float pointSize;
  attribute float mid;
  varying vec3 vColor;
  varying float vMid;
  void main() {
    vColor = color;
    vMid = mid;
    gl_PointSize = pointSize * (mid > 0.5 ? 0.65 : 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Spawns are round with a dark rim so a stack of them still reads as separate dots.
export const spawnMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pointSize: { value: 8 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: `
      varying vec3 vColor;
      varying float vMid;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = d > 0.34 ? vec4(0.04, 0.04, 0.06, 1.0) : vec4(vColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    depthTest: false,
  });

// Roam trails: small dots for the whole zone, and when one mob is focused, only its points survive
// — as large pills, so you can see at a glance whether a polygon covers where it actually goes.
export const roamMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { focused: { value: 0 } },
    vertexShader: `
      uniform float focused;
      attribute float big;
      attribute float shown;
      varying vec3 vColor;
      varying float vBig;
      varying float vShown;
      void main() {
        vColor = color;
        vBig = big;
        vShown = shown;
        gl_PointSize = big > 0.5 ? 9.0 : 2.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float focused;
      varying vec3 vColor;
      varying float vBig;
      varying float vShown;
      void main() {
        // Trails belonging to another floor are not just dimmed: the point of picking a floor is
        // that what is left on screen is on it.
        if (vShown < 0.5) discard;
        if (focused > 0.5 && vBig < 0.5) discard;
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        if (vBig > 0.5) {
          // Cyan core, dark rim. White is what a spawn point looks like, so the focused trail must
          // not borrow it, and cyan reads on top of any region fill.
          gl_FragColor = d > 0.34 ? vec4(0.02, 0.02, 0.04, 1.0) : vec4(0.35, 0.95, 1.0, 1.0);
        } else {
          gl_FragColor = vec4(vColor, 0.6);
        }
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    transparent: true,
    depthTest: false,
  });

// The replay comet: an amber head with a dark rim, and a tail that fades along the way it came.
// Amber because cyan is the trail, white the spawn points and violet the routes.
export const cometMaterial = () =>
  new THREE.ShaderMaterial({
    vertexShader: `
      attribute float big;
      varying vec3 vColor;
      varying float vBig;
      void main() {
        vColor = color;
        vBig = big;
        gl_PointSize = big > 0.5 ? 15.0 : 6.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vBig;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = vBig > 0.5
          ? (d > 0.34 ? vec4(0.05, 0.03, 0.0, 1.0) : vec4(1.0, 0.78, 0.18, 1.0))
          : vec4(vColor, 0.85);
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    transparent: true,
    depthTest: false,
  });

// Polygon handles are squares in the region colour: corners filled, edge midpoints hollow.
export const handleMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pointSize: { value: 9 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: `
      varying vec3 vColor;
      varying float vMid;
      void main() {
        vec2 d = abs(gl_PointCoord - vec2(0.5));
        float edge = max(d.x, d.y);
        if (vMid > 0.5) {
          if (edge < 0.3) discard;
          gl_FragColor = vec4(vColor, 1.0);
        } else {
          gl_FragColor = edge > 0.35 ? vec4(0.04, 0.04, 0.06, 1.0) : vec4(vColor, 1.0);
        }
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    depthTest: false,
  });

// The beacon on whichever mob is being pointed at: a ring rather than a disc, so the dot it is
// marking stays visible inside it. Drawn on top of everything, since finding the mob is the point.
export const beaconMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pointSize: { value: 30 } },
    vertexShader: `
      uniform float pointSize;
      void main() {
        gl_PointSize = pointSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (abs(d - 0.38) > 0.07) discard;
        gl_FragColor = vec4(1.0, 0.95, 0.4, 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    transparent: true,
  });
