
import { CSM } from '../hyperfy/src/core/libs/csm/CSM'
import { isNumber, isString } from 'lodash-es'
import { System } from '../hyperfy/src/core/systems/System.js'
import { logger } from '@elizaos/core';
import * as THREE from 'three';
import { PuppeteerManager } from "../managers/puppeteer-manager.js";
import { resolveUrl } from '../utils.js';

interface SkyHandle {
  node: any
  destroy: () => void
}

interface EnvironmentConfig {
  bg?: string
  hdr?: string
  sunDirection?: THREE.Vector3
  sunIntensity?: number
  sunColor?: string | number
  fogNear?: number
  fogFar?: number
  fogColor?: string
  model?: string
}

export class AgentEnvironment extends System {
  model: any = null
  skys: SkyHandle[] = []
  sky: THREE.Mesh | null = null
  skyN = 0
  base!: EnvironmentConfig
  skyInfo: any = null
  bgUrl: string | null = null
  hdrUrl: string | null = null
  csm!: CSM

  constructor(world: any) {
    super(world)
  }

  async start() {
    this.base = {
      model: 'assets/base-environment.glb',
      bg: 'assets/day2-2k.jpg',
      hdr: 'assets/day2.hdr',
      sunDirection: new THREE.Vector3(-1, -2, -2).normalize(),
      sunIntensity: 1,
      sunColor: 0xffffff,
      fogNear: null,
      fogFar: null,
      fogColor: null,
    }
    this.buildCSM()
    this.refreshSky()

    this.world.settings.on('change', this.onSettingsChange)
    // this.world.prefs.on('change', this.onPrefsChange)
    // this.world.graphics.on('resize', this.onViewportResize)
  }

  async updateModel() {
    const url = this.world.settings.model?.url || this.base.model
    let glb = this.world.loader.get('model', url)
    if (!glb) glb = await this.world.loader.load('model', url)
    if (this.model) this.model.deactivate()
    this.model = glb.toNodes()
    this.model.activate({ world: this.world, label: 'base' })
  }

  addSky(node: any): SkyHandle {
    const handle: SkyHandle = {
      node,
      destroy: () => {
        const idx = this.skys.indexOf(handle)
        if (idx === -1) return
        this.skys.splice(idx, 1)
        this.refreshSky()
      },
    }
    this.skys.push(handle)
    this.refreshSky()
    return handle
  }

  getSky() {
    return this.sky
  }

  /** updateSky without an unhandled rejection: a disconnect closes the page it draws on mid-call. */
  private refreshSky() {
    this.updateSky().catch(error => this.reportRenderError('sky', error))
  }

  private reportRenderError(what: string, error: any) {
    // Expected while the connection is torn down; anything else is worth a warning
    if (error?.name === 'TargetCloseError') {
      console.debug(`[Environment] ${what} update stopped: the render page was closed`)
    } else {
      console.warn(`[Environment] Could not update the ${what}:`, error?.message || error)
    }
  }

  async updateSky() {
    if (!this.sky) {
      const geometry = new THREE.SphereGeometry(1000, 60, 40)
      const material = new THREE.MeshBasicMaterial({side: THREE.BackSide});      
      this.sky = new THREE.Mesh(geometry, material)
      this.sky.geometry.computeBoundsTree()
      this.sky.material.fog = false
      this.sky.material.toneMapped = false
      this.sky.material.needsUpdate = true
      this.sky.matrixAutoUpdate = false
      this.sky.matrixWorldAutoUpdate = false
      this.sky.visible = false
      this.world.stage.scene.add(this.sky)
    }

    const base = this.base
    const node = this.skys[this.skys.length - 1]?.node
    let bgUrl = node?._bg || base.bg
    const hdrUrl = node?._hdr || base.hdr
    const sunDirection = node?._sunDirection || base.sunDirection
    const sunIntensity = isNumber(node?._sunIntensity) ? node._sunIntensity : base.sunIntensity
    const sunColor = isString(node?._sunColor) ? node._sunColor : base.sunColor
    const fogNear = isNumber(node?._fogNear) ? node._fogNear : base.fogNear
    const fogFar = isNumber(node?._fogFar) ? node._fogFar : base.fogFar
    const fogColor = isString(node?._fogColor) ? node._fogColor : base.fogColor
    const puppeteerManager = PuppeteerManager.getInstance()
    const n = ++this.skyN
    let bgUUID
    if (bgUrl) {
      bgUrl = await resolveUrl(bgUrl, this.world);
      bgUUID = await puppeteerManager.registerTexture(bgUrl, 'map');
    }
    if (bgUUID) {
      this.sky.material.userData.materialId = bgUUID;
      this.sky.visible = true
    } else {
      this.sky.visible = false
    }

    if (hdrUrl) {
      await puppeteerManager.loadEnvironmentHDR(hdrUrl);
    }
    if (n !== this.skyN) return

    this.csm.lightDirection = sunDirection

    for (const light of this.csm.lights) {
      light.intensity = sunIntensity
      light.color.set(sunColor)
    }

    if (isNumber(fogNear) && isNumber(fogFar) && fogColor) {
      const color = new THREE.Color(fogColor)
      this.world.stage.scene.fog = new THREE.Fog(color, fogNear, fogFar)
    } else {
      this.world.stage.scene.fog = null
    }

    this.skyInfo = {
      bgUrl,
      hdrUrl,
      sunDirection,
      sunIntensity,
      sunColor,
      fogNear,
      fogFar,
      fogColor,
    }
  }

  update(delta: number) {
    this.csm?.update()
  }

  lateUpdate(delta: number) {
    if (!this.sky) return
    this.sky.position.x = this.world.rig.position.x
    this.sky.position.z = this.world.rig.position.z
    this.sky.matrixWorld.setPosition(this.sky.position)
  }

  buildCSM() {
    const options = {
      cascades: 3,
      shadowMapSize: 2048,
      castShadow: true,
      lightIntensity: 1,
      shadowBias: 0.000003,
      shadowNormalBias: 0.002,
    }
    if (this.csm) {
      this.csm.updateCascades(options.cascades)
      this.csm.updateShadowMapSize(options.shadowMapSize)
      this.csm.lightDirection = this.skyInfo?.sunDirection
      for (const light of this.csm.lights) {
        light.intensity = this.skyInfo?.sunIntensity
        light.color.set(this.skyInfo?.sunColor)
        light.castShadow = options.castShadow
      }
    } else {
      this.csm = new CSM({
        mode: 'practical',
        cascades: 3,
        maxCascades: 3,
        shadowMapSize: 2048,
        maxFar: 100,
        lightIntensity: 1,
        lightDirection: new THREE.Vector3(0, -1, 0).normalize(),
        fade: true,
        parent: this.world.stage.scene,
        camera: this.world.camera,
        ...options,
      })
      if (!options.castShadow) {
        for (const light of this.csm.lights) {
          light.castShadow = false
        }
      }
    }
  }

  onSettingsChange = (changes: Record<string, any>) => {
    if (changes.model) {
      this.updateModel().catch(error => this.reportRenderError('model', error))
    }
  }

  onPrefsChange = (changes: Record<string, any>) => {
    if (changes.shadows) {
      this.buildCSM()
      this.refreshSky()
    }
  }

  onViewportResize = () => {
    this.csm.updateFrustums()
  }
}
