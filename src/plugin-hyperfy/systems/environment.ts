
import { CSM } from '../hyperfy/src/core/libs/csm/CSM'
import { isNumber, isString } from 'lodash-es'
import { System } from '../hyperfy/src/core/systems/System.js'
import * as THREE from 'three';
import { PuppeteerManager } from "../managers/puppeteer-manager.js";
import { ASSET_BYTE_CAPS, type AssetBytes, fetchAssetBytes } from '../lib/asset-bytes';
import { assetMemory, workBytes } from '../lib/asset-memory';
import { describeUrl } from '../lib/log-url';
import { PageWork } from '../lib/page-work';

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
  fogNear?: number | null
  fogFar?: number | null
  fogColor?: string | null
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
  /** The sky update in progress: a newer one, or destroy(), stops it */
  private skyWork: AbortController | null = null
  private destroyed = false
  /** Page work when the world has no loader to share it with (lib/page-work.ts) */
  private ownPageWork = new PageWork()

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

  /**
   * Starts a sky update and stops the one before it (latest wins): at most one sky download is in
   * flight. Without an unhandled rejection: a disconnect closes the page it draws on mid-call.
   */
  private refreshSky() {
    this.skyWork?.abort()
    const work = new AbortController()
    this.skyWork = work
    this.updateSky(work.signal).catch(error => {
      // A stopped update fails as it was meant to
      if (!work.signal.aborted) this.reportRenderError('sky', error)
    })
  }

  destroy() {
    this.destroyed = true
    this.skyWork?.abort()
    this.skyWork = null
    this.world.settings?.off?.('change', this.onSettingsChange)
  }

  private reportRenderError(what: string, error: any) {
    // Expected while the connection is torn down; anything else is worth a warning
    if (error?.name === 'TargetCloseError') {
      console.debug(`[Environment] ${what} update stopped: the render page was closed`)
    } else {
      console.warn(`[Environment] Could not update the ${what}:`, error?.message || error)
    }
  }

  /**
   * Downloads `url` and hands it to the render page with `pageCall`, under the world's page work
   * (a kill blames it only when it was alone; lib/page-work.ts) and the agent's memory reservation
   * (lib/asset-memory.ts), held until the page call is over. Null when `signal` fired meanwhile.
   */
  private async toPage<T>(url: string, kind: 'image' | 'hdr', signal: AbortSignal, pageCall: (asset: AssetBytes) => Promise<T>): Promise<{ asset: AssetBytes; result: T } | null> {
    const work: PageWork = this.world.loader?.pageWork ?? this.ownPageWork
    const key = `${kind}/${url}`
    const refused = work.refusal(key)
    if (refused) throw new Error(`[Environment] Not handing the ${kind} ${describeUrl(url)} to the render page again: ${refused}`)
    const lease = await assetMemory.download(ASSET_BYTE_CAPS[kind], signal)
    try {
      const asset = await fetchAssetBytes(this.world, url, kind, { signal, lease })
      if (signal.aborted || this.destroyed) return null
      await lease.toWork(workBytes(kind, asset.bytes.byteLength), signal)
      if (signal.aborted || this.destroyed) return null
      const result = await work.run(key, `the ${kind} ${describeUrl(url)}`, () => pageCall(asset))
      return { asset, result }
    } finally {
      lease.release()
    }
  }

  /** Applies the current sky. Every change to the scene or the render page is made only while `signal` holds. */
  async updateSky(signal: AbortSignal = new AbortController().signal) {
    const stopped = () => signal.aborted || this.destroyed
    if (stopped()) return
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
      // Downloaded here, under the world's network policy: the render page has no network
      const done = await this.toPage(bgUrl, 'image', signal, (image) => puppeteerManager.registerTexture(image, 'map', { signal }))
      if (!done || stopped()) return
      bgUrl = done.asset.url;
      bgUUID = done.result;
    }
    if (bgUUID) {
      this.sky.material.userData.materialId = bgUUID;
      this.sky.visible = true
    } else {
      this.sky.visible = false
    }

    if (hdrUrl) {
      const done = await this.toPage(hdrUrl, 'hdr', signal, (hdr) => puppeteerManager.loadEnvironmentHDR(hdr.bytes, { signal }))
      if (!done) return
    }
    if (n !== this.skyN || stopped()) return

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
        maxCascades: 3,
        maxFar: 100,
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
