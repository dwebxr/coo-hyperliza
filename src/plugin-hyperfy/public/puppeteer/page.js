/*
 * The render page: the agent's headless Chromium draws the world here for its snapshots.
 *
 * scripts/build-assets.mjs bundles this file, three.js, three-vrm and ../scripts/* into one
 * classic script (dist/puppeteer/page.js), which managers/puppeteer-manager.ts adds to an empty
 * page. Nothing is loaded by URL: the page has no network, and every asset arrives as bytes from
 * the agent (see ./assets.js).
 *
 * `three` here is three.js 0.132.2 and `@pixiv/three-vrm` 3.3.3 (the devDependencies page-three
 * and page-three-vrm), not the versions the agent itself runs on; the build maps the names.
 */
import * as THREE from 'three';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader }    from 'three/addons/loaders/RGBELoader.js';
import { GLTFExporter }  from 'three/addons/exporters/GLTFExporter.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
// These define functions on window that read the globals set below when they are called
import '../scripts/createVRMFactory.js';
import '../scripts/snapshotEquirectangular.js';
import '../scripts/snapshotFacingDirection.js';
import '../scripts/snapshotViewToTarget.js';
import './assets.js';

const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

/* --- GLTF / VRM loader ------------------------------------------------ */
const VRMLoader = new GLTFLoader();
VRMLoader.register(parser => new VRMLoaderPlugin(parser));

window.scene          = scene;
window.camera         = camera;
window.renderer       = renderer;
window.THREE          = THREE;
window.GLTFLoader     = GLTFLoader;
window.VRMLoader      = VRMLoader;
window.ObjectLoader   = THREE.ObjectLoader;
window.MaterialLoader = THREE.MaterialLoader;
window.TextureLoader  = new THREE.TextureLoader();
window.GLTFExporter   = GLTFExporter;
window.RGBELoader     = RGBELoader;
window.SkeletonUtils = SkeletonUtils;
