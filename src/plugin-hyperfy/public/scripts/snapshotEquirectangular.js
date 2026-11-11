/*
 * The view all around the player as one equirectangular picture: six square views (the faces of a
 * cube map) drawn from the player's eye, then unrolled by a shader.
 *
 * Each face is drawn into a render target of its own, not into a face of one cube render target:
 * three.js 0.132.2 draws a scene that holds a transmissive material (glass) in two passes, and
 * after the first it goes back to the render target it was given without its face
 * (WebGLRenderer.renderTransmissionPass), which is face 0. With a cube render target every view
 * was then drawn into that one face and the other five stayed black.
 */

// The views of a cube map in the order +X, -X, +Y, -Y, +Z, -Z, as three's CubeCamera sets them up
const CUBE_FACES = [
  { up: [0, -1, 0], look: [1, 0, 0] },
  { up: [0, -1, 0], look: [-1, 0, 0] },
  { up: [0, 0, 1], look: [0, 1, 0] },
  { up: [0, 0, -1], look: [0, -1, 0] },
  { up: [0, -1, 0], look: [0, 0, 1] },
  { up: [0, -1, 0], look: [0, 0, -1] },
];

window.snapshotEquirectangular = async function(playerData) {
    const THREE = window.THREE;
    const renderer = window.renderer;
    const scene = window.scene;

    const size = 1024;
    const rtWidth = 2048;
    const rtHeight = 1024;

    const eye = new THREE.Vector3().fromArray(playerData.position);
    eye.y += 2;

    const rig = new THREE.Object3D();
    rig.position.copy(eye);
    rig.quaternion.set(
      ...playerData.quaternion
    );
    const cameras = CUBE_FACES.map(({ up, look }) => {
      const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
      camera.up.set(...up);
      camera.lookAt(new THREE.Vector3(...look));
      rig.add(camera);
      return camera;
    });
    rig.updateMatrixWorld();

    // Made for this one snapshot, and freed whether or not it succeeds
    const made = [];
    const keep = (resource) => {
      made.push(resource);
      return resource;
    };
    const before = renderer.getRenderTarget();
    try {
      const faces = cameras.map(() => keep(new THREE.WebGLRenderTarget(size, size, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      })));
      cameras.forEach((camera, face) => {
        renderer.setRenderTarget(faces[face]);
        renderer.render(scene, camera);
      });

      const renderTarget = keep(new THREE.WebGLRenderTarget(rtWidth, rtHeight));
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const sceneRTT = new THREE.Scene();

      const material = keep(new THREE.ShaderMaterial({
        uniforms: {
          facePX: { value: faces[0].texture },
          faceNX: { value: faces[1].texture },
          facePY: { value: faces[2].texture },
          faceNY: { value: faces[3].texture },
          facePZ: { value: faces[4].texture },
          faceNZ: { value: faces[5].texture },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          uniform sampler2D facePX;
          uniform sampler2D faceNX;
          uniform sampler2D facePY;
          uniform sampler2D faceNY;
          uniform sampler2D facePZ;
          uniform sampler2D faceNZ;
          varying vec2 vUv;

          const float PI = 3.14159265359;

          // What textureCube() gives for a cube map made of the six faces: the face the direction
          // points into most, and where in it (the rule of the OpenGL ES specification)
          vec4 cube(vec3 dir) {
            vec3 a = abs(dir);
            if (a.x >= a.y && a.x >= a.z) {
              return dir.x > 0.0
                ? texture2D(facePX, vec2(-dir.z, -dir.y) / (2.0 * a.x) + 0.5)
                : texture2D(faceNX, vec2(dir.z, -dir.y) / (2.0 * a.x) + 0.5);
            }
            if (a.y >= a.z) {
              return dir.y > 0.0
                ? texture2D(facePY, vec2(dir.x, dir.z) / (2.0 * a.y) + 0.5)
                : texture2D(faceNY, vec2(dir.x, -dir.z) / (2.0 * a.y) + 0.5);
            }
            return dir.z > 0.0
              ? texture2D(facePZ, vec2(dir.x, -dir.y) / (2.0 * a.z) + 0.5)
              : texture2D(faceNZ, vec2(-dir.x, -dir.y) / (2.0 * a.z) + 0.5);
          }

          void main() {
            vec2 uv = vUv;
            uv.x = 1.0 - uv.x;
            float theta = uv.x * 2.0 * PI;
            float phi = uv.y * PI;
            vec3 dir = vec3(
              sin(theta) * sin(phi),
              cos(phi),
              cos(theta) * sin(phi)
            );
            gl_FragColor = cube(dir);
          }
        `
      }));

      const plane = keep(new THREE.PlaneGeometry(2, 2));
      const quad = new THREE.Mesh(plane, material);
      sceneRTT.add(quad);

      renderer.setRenderTarget(renderTarget);
      renderer.render(sceneRTT, camera);
      renderer.setRenderTarget(null);

      const pixels = new Uint8Array(rtWidth * rtHeight * 4);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, rtWidth, rtHeight, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = rtWidth;
      canvas.height = rtHeight;
      const ctx = canvas.getContext('2d');
      const imageData = ctx.createImageData(rtWidth, rtHeight);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);

      return canvas.toDataURL('image/jpeg').split(',')[1];
    } finally {
      renderer.setRenderTarget(before);
      for (const resource of made) resource.dispose();
    }
};
