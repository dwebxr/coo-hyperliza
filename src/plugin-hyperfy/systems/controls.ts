import { System } from '../hyperfy/src/core/systems/System.js'
import { logger } from '@elizaos/core';
import * as THREE from 'three';
import { Vector3Enhanced } from '../hyperfy/src/core/extras/Vector3Enhanced.js'
import { ControlPriorities } from '../hyperfy/src/core/extras/ControlPriorities.js'
import { buttons } from '../hyperfy/src/core/extras/buttons.js'
import { errorText } from '../lib/error-text'

const FORWARD = new THREE.Vector3(0, 0, -1)
const v1 = new THREE.Vector3()
const e1 = new THREE.Euler(0, 0, 0, 'YXZ')
const e2 = new THREE.Euler(0, 0, 0, 'YXZ')
const q1 = new THREE.Quaternion()
const q2 = new THREE.Quaternion()

// Define Navigation Constants
const CONTROLS_TICK_INTERVAL = 100; // ms
const NAVIGATION_STOP_DISTANCE = 0.5; // meters
const FOLLOW_STOP_DISTANCE = 2.5; // meters
const RANDOM_WALK_DEFAULT_INTERVAL = 5000; // ms <-- SET TO 5 SECONDS
const RANDOM_WALK_DEFAULT_MAX_DISTANCE = 7; // meters

function createButtonState() {
  return {
    $button: true,
    down: false,
    pressed: false,
    released: false,
  }
}

/** What app.control() gives a world script: see AgentControls.bind */
export interface AppControl {
  readonly [key: string]: any;
  release(): void;
}

function bindRotations(quaternion: THREE.Quaternion, euler: THREE.Euler) {
  ; (euler as any)._onChange(() => {
    quaternion.setFromEuler(euler, false)
  })
  ; (quaternion as any)._onChange(() => {
    euler.setFromQuaternion(quaternion, undefined, false)
  })
}

class ControlsToken {
  private _isAborted = false;
  abort() { this._isAborted = true; }
  get aborted() { return this._isAborted; }
}

/**
 * `signal`: the turn (or connection) the movement is for. When it fires while the movement is
 * still the current one, the movement stops; when it has fired already, nothing is started. A
 * turn that completed leaves its signal as it is, so what it left running goes on.
 */
export interface MoveOptions {
  signal?: AbortSignal;
}

export class AgentControls extends System {
  // Button states by key name (keyW, space, ...): set in the constructor and by setKey
  [key: string]: any;
  // Define expected control properties directly on the instance
  scrollDelta = { value: 0 };
  pointer = { locked: false, delta: { x: 0, y: 0 } };
  camera: any = undefined; // PlayerLocal checks for this
  screen: any = undefined; // PlayerLocal checks for this
  xrLeftStick = { value: { x: 0, y: 0, z: 0 } };
  xrRightStick = { value: { x: 0, y: 0, z: 0 } };
  keyW: any;
  keyA: any;
  keyS: any;
  keyD: any;
  space: any;
  shiftLeft: any;
  shiftRight: any;
  controlLeft: any;
  keyC: any;
  keyF: any;
  keyE: any;
  arrowUp: any;
  arrowDown: any;
  arrowLeft: any;
  arrowRight: any;
  touchA: any;
  touchB: any;
  xrLeftBtn1: any;
  xrLeftBtn2: any;
  xrRightBtn1: any;
  xrRightBtn2: any;

  // --- Navigation State --- >
  private _navigationTarget: THREE.Vector3 | null = null;
  private _isNavigating: boolean = false;
  private _currentNavKeys: { forward: boolean, backward: boolean, left: boolean, right: boolean } = {
    forward: false, backward: false, left: false, right: false
  };
  private _navigationResolve: (() => void) | null = null;
  // <------------------------

  /** Controls bound by world scripts (bind); nothing in them refers back to this system */
  private appControls = new Set<AppControl>();

  private _currentWalkToken: ControlsToken | null = null;
  private _isRandomWalking: boolean = false;

  private _isRotating = false;
  private _rotationTarget: THREE.Quaternion | null = null;
  private _rotationAbortController: ControlsToken | null = null;

  constructor(world: any) {
    super(world); // Call base System constructor

    const commonKeys = [
      'keyW', 'keyA', 'keyS', 'keyD', 'space', 'shiftLeft', 'shiftRight',
      'controlLeft', 'keyC', 'keyF', 'keyE', 'keyX', 'arrowUp', 'arrowDown',
      'arrowLeft', 'arrowRight', 'touchA', 'touchB', 'xrLeftStick',
      'xrRightStick', 'xrLeftBtn1', 'xrLeftBtn2', 'xrRightBtn1', 'xrRightBtn2',
    ];
    commonKeys.forEach(key => {
      this[key] = createButtonState();
    });

    this.camera = this.createCamera(this);
  }

  // Method for the agent script to set a key state
  setKey(keyName: string, isDown: boolean) {
    if (!this[keyName] || !this[keyName].$button) {
      // If the key doesn't exist or isn't a button state, log a warning or initialize
      logger.warn(`[Controls] Attempted to set unknown or non-button key: ${keyName}. Initializing.`);
      this[keyName] = createButtonState(); // Create if missing
    }
    const state = this[keyName];

    // Check if the state actually changed to avoid redundant updates
    const changed = state.down !== isDown;

    if (isDown && !state.down) {
      state.pressed = true;
      state.released = false;
    } else if (!isDown && state.down) {
      state.released = true;
      state.pressed = false;
    }
    state.down = isDown;

    // Optional: Log the key press/release
    // if (changed) {
    //     logger.debug(`[Controls] setKey: ${keyName} = ${isDown}`);
    // }
  }

  // Reset pressed/released flags at the end of the frame
  // This is important for detecting single presses/releases
  postLateUpdate() {
    for (const key in this) {
      if (this.hasOwnProperty(key) && this[key] && (this[key] as any).$button) {
        (this[key] as any).pressed = false;
        (this[key] as any).released = false;
      }
    }
    for (const control of this.appControls) {
      for (const name of buttons) {
        control[name].pressed = false;
        control[name].released = false;
      }
    }
    // We don't run navigationTick here, it runs on its own interval
  }

  // --- Random Walk Methods --- >

  /**
   * Starts the agent walking to random nearby points.
   */
  public async startRandomWalk(
    interval: number = RANDOM_WALK_DEFAULT_INTERVAL,
    maxDistance: number = RANDOM_WALK_DEFAULT_MAX_DISTANCE,
    duration: number = 30000,
    { signal }: MoveOptions = {}
  ) {
    if (signal?.aborted) return;
    this.stopRandomWalk(); // cancel if already running
    this._isRandomWalking = true;
    logger.info("[Controls] Random walk started.");

    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
    const token = new ControlsToken();
    this._currentWalkToken = token;
    const untie = this.stopWith(signal, token);
    const tmpTarget = new THREE.Vector3();
    const walkLoop = async () => {
      const startTime = Date.now();

      while (this._isRandomWalking && this.world?.entities?.player && !token.aborted && this._currentWalkToken === token) {
        // Stop if duration expired and still same walk token
        if (
          duration !== undefined &&
          (Date.now() - startTime) >= duration &&
          this._currentWalkToken === token &&
          !token.aborted
        ) {
          logger.info("[Controls] Random walk duration reached. Stopping.");
          break;
        }

        const pos = this.world.entities.player.base.position;
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * maxDistance;
        const targetX = pos.x + Math.cos(angle) * radius;
        const targetZ = pos.z + Math.sin(angle) * radius;
        try {
          tmpTarget.set(targetX, 0, targetZ);
          this.stopNavigation("starting new navigation");
          this._currentWalkToken = token;
          this._isNavigating = true;

          await this._navigateTowards(() => tmpTarget, NAVIGATION_STOP_DISTANCE, token, false);
        } catch (e) {
          logger.warn(`[Random Walk] Navigation error: ${errorText(e)}`);
        }

        await delay(Math.random() * interval);
      }
      untie();
      if (this._currentWalkToken === token && !token.aborted) {
        this.stopRandomWalk();
      }
    };

    walkLoop();
  }

  // --- Navigation Methods --- >

  /**
   * Navigates toward an entity (by ID) until within stop distance.
   */
  public async followEntity(entityId: string, stopDistance: number = FOLLOW_STOP_DISTANCE, { signal }: MoveOptions = {}): Promise<void> {
    if (signal?.aborted) return;
    this.stopRandomWalk();
    this.stopNavigation("starting followEntity");

    const token = new ControlsToken();
    this._currentWalkToken = token;
    this._isNavigating = true;
    const untie = this.stopWith(signal, token);
    try {
      await this._navigateTowards(() => {
        const target = this.world.entities.items.get(entityId);
        if (!target) return null;
        return target.base?.position?.clone() || target.root?.position?.clone() || null;
      }, stopDistance, token);
    } finally {
      untie();
    }
  }

  /**
   * Stops the navigation `token` stands for when `signal` fires, unless a newer one has taken its
   * place by then. Returns how to undo the tie (once that navigation has ended by itself).
   */
  private stopWith(signal: AbortSignal | undefined, token: ControlsToken): () => void {
    if (!signal) return () => { };
    const onAbort = () => {
      if (this._currentWalkToken !== token) return;
      logger.info("[Controls] Stopping a navigation: what it was for was cancelled.");
      this.stopRandomWalk();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  /**
   * Teleports the agent to the specified position and optional rotation. False when there is no player.
   */
  public teleportTo(position: THREE.Vector3, rotationY?: number): boolean {
    const player = this.world?.entities?.player;
    if (!player) {
      logger.warn("[Controls] Cannot teleport: Player entity not found.");
      return false;
    }

    logger.info(`[Controls] Teleporting to ${position.x}, ${position.y}, ${position.z}`);
    this.stopAllActions("teleporting");

    player.teleport({
      position: position,
      rotationY: rotationY,
    });
    return true;
  }

  /**
   * Teleports the agent to the location of a specific entity. False when it did not teleport.
   */
  public teleportToEntity(entityId: string): boolean {
    const target = this.world?.entities?.items?.get(entityId);
    if (!target) {
      logger.warn(`[Controls] Cannot teleport to entity ${entityId}: Entity not found.`);
      return false;
    }

    const position = target.base?.position?.clone() || target.root?.position?.clone();
    if (!position) {
      logger.warn(`[Controls] Cannot teleport to entity ${entityId}: Position not found.`);
      return false;
    }

    // Teleport slightly offset to avoid clipping inside the target
    // We'll try to teleport 1 meter "in front" if possible, or just at the position
    // For simplicity, let's just teleport to the position for now, maybe add a small Y offset
    const safePosition = position.clone();
    // safePosition.y += 0.1; // Slight lift

    return this.teleportTo(safePosition);
  }



  /**
   * Starts navigating the agent towards the target X, Z coordinates.
   */
  public async goto(x: number, z: number, { signal }: MoveOptions = {}): Promise<void> {
    if (signal?.aborted) return;
    this.stopAllActions("starting new navigation");

    const navigationToken = new ControlsToken();
    this._currentWalkToken = navigationToken;
    this._navigationTarget = new THREE.Vector3(x, 0, z);
    this._isNavigating = true;
    const untie = this.stopWith(signal, navigationToken);
    try {
      await this._navigateTowards(() => this._navigationTarget, NAVIGATION_STOP_DISTANCE, navigationToken);
    } finally {
      untie();
    }
  }


  private async _navigateTowards(
    getTargetPosition: () => THREE.Vector3,
    stopDistance: number,
    token: ControlsToken,
    allowSprint: boolean = true
  ): Promise<void> {
    const player = this.world.entities.player;
    const tickDelay = (ms: number) => new Promise(res => setTimeout(res, ms));

    let previousPosition = player.base.position.clone();
    let noProgressTicks = 0;
    const STUCK_THRESHOLD = 0.05;
    const MAX_NO_PROGRESS_TICKS = 10;
    let recoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 3;
    const SPRINT_DISTANCE_THRESHOLD = 15.0;

    while (!token.aborted && this._currentWalkToken === token) {
      if (!this._validatePlayerState("_navigateTowards")) break;

      const targetPos = getTargetPosition();
      if (!targetPos) {
        logger.warn(`[Controls] Target position is null during navigation.`);
        this.stopNavigation("target null");
        break;
      }

      const playerPos = v1.copy(player.base.position);
      const distance = playerPos.clone().setY(0).distanceTo(targetPos.clone().setY(0));

      if (distance <= stopDistance) {
        logger.info(`[Controls] Reached target within ${stopDistance}m.`);
        this.stopNavigation("target reached");
        break;
      }

      // --- Stuck Detection ---
      const progressDistance = playerPos.distanceTo(previousPosition);
      if (progressDistance < STUCK_THRESHOLD) {
        noProgressTicks++;
      } else {
        noProgressTicks = 0;
      }
      previousPosition.copy(playerPos);

      if (noProgressTicks >= MAX_NO_PROGRESS_TICKS) {
        if (++recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
          logger.error("[Controls] Max recovery attempts reached. Teleporting to target.");

          const targetPos = getTargetPosition();
          if (targetPos) {
            const direction = targetPos.clone().sub(player.base.position).setY(0).normalize();
            const finalPosition = targetPos.clone().addScaledVector(direction, -stopDistance);
            const yRotation = Math.atan2(-direction.x, -direction.z);

            player.teleport({
              position: finalPosition,
              rotationY: yRotation,
            });
          }

          this.stopNavigation("teleported after max recovery");
          break;
        }

        logger.warn("[Controls] Stuck detected. Attempting recovery rotation.");
        const randomDir: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
        try {
          await Promise.race([
            this.rotateTo(randomDir, 500),
            tickDelay(1000), // fallback timeout
          ]);
        } catch (e) {
          logger.error(`[Controls] Rotation during stuck recovery failed: ${errorText(e)}`);
        }
        this.setKey('space', true);
        noProgressTicks = 0;
      } else {
        // Face toward target
        const direction = targetPos.clone().sub(playerPos).setY(0).normalize();
        const desiredQuat = q1.setFromUnitVectors(FORWARD, direction);
        player.base.quaternion = desiredQuat;
        const yRot = e1.setFromQuaternion(player.base.quaternion, 'YXZ').y;
        player.cam.rotation.y = yRot;
        this.setKey('space', false);
      }

      // Simulate movement
      this.setKey('keyW', true);
      this.setKey('keyS', false);
      this.setKey('keyA', false);
      this.setKey('keyD', false);
      this.setKey('shiftLeft', allowSprint && distance > SPRINT_DISTANCE_THRESHOLD);

      await tickDelay(CONTROLS_TICK_INTERVAL);
    }
  }

  public async rotateTo(direction: 'front' | 'back' | 'left' | 'right', duration: number = 500, { signal }: MoveOptions = {}): Promise<void> {
    const player = this.world?.entities?.player;
    if (!player?.base) {
      logger.warn("[Controls rotateTo] Player entity not ready.");
      return;
    }
    if (signal?.aborted) return;

    this.stopRotation();
    this._isRotating = true;
    const token = new ControlsToken();
    this._rotationAbortController = token;

    // Determine target quaternion
    const rotationOffsetY: Record<'front' | 'back' | 'left' | 'right', number> = {
      front: 0,
      right: -Math.PI / 2,
      back: Math.PI,
      left: Math.PI / 2,
    };

    const baseQuat = player.base.quaternion.clone();
    const yawQuat = q2.setFromEuler(
      new THREE.Euler(0, rotationOffsetY[direction], 0, 'YXZ')
    );
    await this._rotateToward(baseQuat.clone().multiply(yawQuat), duration, token, signal);
  }

  /**
   * Turns in place to face an entity (e.g. a player). Visible to others without any emote clip.
   */
  public async faceEntity(entityId: string, duration: number = 600, { signal }: MoveOptions = {}): Promise<void> {
    const player = this.world?.entities?.player;
    const target = this.world?.entities?.items?.get(entityId);
    const targetPos = target?.base?.position || target?.root?.position;
    if (!player?.base || !targetPos || signal?.aborted) return;

    const direction = targetPos.clone().sub(player.base.position).setY(0);
    if (direction.lengthSq() < 1e-6) return;

    this.stopRotation();
    this._isRotating = true;
    const token = new ControlsToken();
    this._rotationAbortController = token;
    await this._rotateToward(new THREE.Quaternion().setFromUnitVectors(FORWARD, direction.normalize()), duration, token, signal);
  }

  private async _rotateToward(target: THREE.Quaternion, duration: number, token: ControlsToken, signal?: AbortSignal): Promise<void> {
    const player = this.world.entities.player;
    this._rotationTarget = target;

    const startQuat = player.base.quaternion.clone();
    const totalSteps = Math.ceil(duration / CONTROLS_TICK_INTERVAL);
    let step = 0;

    const tickDelay = (ms: number) => new Promise(res => setTimeout(res, ms));

    // `signal`: what the turn is for was cancelled; the turn stops where it is
    while (this._isRotating && !token.aborted && !signal?.aborted && step <= totalSteps) {
      const t = step / totalSteps;

      player.base.quaternion.copy(startQuat).slerp(this._rotationTarget, t);
      const euler = e2.setFromQuaternion(player.base.quaternion, 'YXZ');
      player.cam.rotation.y = euler.y;

      await tickDelay(CONTROLS_TICK_INTERVAL);
      step++;
    }

    // A newer rotation may have started meanwhile; leave its state alone
    if (this._rotationAbortController === token) {
      this._isRotating = false;
      this._rotationAbortController = null;
    }
  }

  /**
  * Stops the random walk process.
  */
  public stopRandomWalk() {
    this._isRandomWalking = false;
    this._currentWalkToken?.abort();
    this._currentWalkToken = null;
    this.stopNavigation("random walk stopped");
  }

  /**
  * Stops the current navigation process AND random walk if active.
  */
  public stopNavigation(reason: string = "commanded"): void {
    if (this._isNavigating) {
      logger.info(`[Controls Navigation] Stopping navigation (${reason}). Reason stored.`);

      if (this._navigationResolve) {
        this._navigationResolve();
        this._navigationResolve = null;
      }

      this._isNavigating = false;
      this._navigationTarget = null;

      // Release movement keys
      try {
        this.setKey('keyW', false);
        this.setKey('space', false);
        this.setKey('keyA', false);
        this.setKey('keyS', false);
        this.setKey('keyD', false);
        this.setKey('shiftLeft', false);
        logger.debug("[Controls Navigation] Movement keys released.");
      } catch (e) {
        logger.error(`[Controls Navigation] Error releasing keys on stop: ${errorText(e)}`);
      }
      this._currentNavKeys = { forward: false, backward: false, left: false, right: false };
    }
  }

  public stopRotation() {
    if (this._isRotating) {
      logger.info("[Controls stopRotation] Rotation cancelled.");
      this._rotationAbortController?.abort();
      this._rotationAbortController = null;
      this._isRotating = false;
      this._rotationTarget = null;
    }
  }

  public stopAllActions(reason: string = "stopAllActions called") {
    logger.info(`[Controls] Stopping all actions. Reason: ${reason}`);

    this.stopRandomWalk();     // Also stops navigation
    this.stopNavigation(reason);
    this.stopRotation();
  }


  /**
   * Returns whether the agent is currently navigating towards a target.
   */
  public getIsNavigating(): boolean {
    return this._isNavigating;
  }

  public getIsWalkingRandomly(): boolean {
    return this._isRandomWalking;
  }

  /** Helper to check if player and base position/quaternion are valid */
  private _validatePlayerState(caller: string): boolean {
    const player = this.world?.entities?.player;
    if (!player?.base) {
      logger.error(`[Controls ${caller}] Cannot proceed: Player entity or base not found.`);
      return false;
    }
    // --- Enhanced Checks ---
    const pos = player.base.position;
    const quat = player.base.quaternion;

    if (!(pos instanceof THREE.Vector3 || pos instanceof Vector3Enhanced)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.position must be a THREE.Vector3 or Vector3Enhanced.`);
      return false;
    }
    if (isNaN(pos.x) || isNaN(pos.y) || isNaN(pos.z)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.position contains NaN values.`);
      return false;
    }

    if (!(quat instanceof THREE.Quaternion)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.quaternion is not a THREE.Quaternion.`);
      return false;
    }
    if (isNaN(quat.x) || isNaN(quat.y) || isNaN(quat.z) || isNaN(quat.w)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.quaternion contains NaN values.`);
      return false;
    }
    // Check if quaternion is normalized (length approx 1)
    const quatLengthSq = quat.lengthSq();
    if (Math.abs(quatLengthSq - 1.0) > 0.01) { // Allow small tolerance
      logger.warn(`[Controls ${caller}] Player quaternion is not normalized (lengthSq: ${quatLengthSq.toFixed(4)}). Attempting normalization.`);
      // Attempt to normalize in place if possible, or log warning
      quat.normalize();
    }

    logger.debug(`[Controls ${caller}] Player state validated successfully.`);
    // ---------------------
    return true;
  }

  createCamera(self: AgentControls) {
    const world = self.world;
    const position = new THREE.Vector3().copy(world.rig?.position || new THREE.Vector3());
    const quaternion = new THREE.Quaternion().copy(world.rig?.quaternion || new THREE.Quaternion());
    const rotation = new THREE.Euler(0, 0, 0, 'YXZ').copy(world.rig?.rotation || new THREE.Euler());
    bindRotations(quaternion, rotation);
    const zoom = world.camera?.position?.z ?? 10;

    return {
      $camera: true,
      position,
      quaternion,
      rotation,
      zoom,
      write: false,
    };
  }

  /**
   * The engine's controls.bind(). The local player (PlayerLocal) binds with PLAYER priority and
   * reads the agent's keys and camera from what it gets back, so it gets this system itself.
   *
   * Every other caller is a world app script calling app.control() (systems/Apps.js forces APP
   * priority). It gets an object of its own that leads nowhere: button states, a camera and a
   * pointer that only it reads and writes. The agent's own simulated keys do not show in it; the
   * one thing the agent does with it is press keyX when it releases an item
   * (AgentActions.releaseAction), which is how a seat or vehicle script learns the agent wants out.
   */
  bind(options: any = {}): AgentControls | AppControl {
    if (options?.priority === ControlPriorities.PLAYER) return this;
    const controls = this;
    const entries: Record<string, any> = {};
    for (const name of buttons) entries[name] = { ...createButtonState(), onPress: null, onRelease: null };
    const quaternion = new THREE.Quaternion();
    const rotation = new THREE.Euler(0, 0, 0, 'YXZ');
    bindRotations(quaternion, rotation);
    let released = false;
    const control: AppControl = Object.freeze({
      ...entries,
      camera: { $camera: true, position: new THREE.Vector3(), quaternion, rotation, zoom: 0, write: false },
      pointer: { locked: false, delta: { x: 0, y: 0 }, lock() { }, unlock() { } },
      screen: Object.freeze({ width: 1920, height: 1080 }),
      scrollDelta: { value: 0 },
      xrLeftStick: { value: { x: 0, y: 0, z: 0 } },
      xrRightStick: { value: { x: 0, y: 0, z: 0 } },
      setActions() { },
      release() {
        if (released) return;
        released = true;
        controls.appControls.delete(control);
        // The script's own callback, if it passed one to app.control(). The engine calls release()
        // while it tears an app down, which a throwing callback must not interrupt.
        try {
          if (typeof options?.onRelease === 'function') options.onRelease();
        } catch (error: any) {
          logger.warn(`[Controls] A world script's onRelease handler threw: ${error?.message ?? error}`);
        }
      },
    });
    this.appControls.add(control);
    return control;
  }

  /** Presses or releases a button on every control a world script holds, calling its handler */
  pressAppButton(name: string, down: boolean) {
    for (const control of this.appControls) {
      const button = control[name];
      if (!button?.$button || button.down === down) continue;
      button.down = down;
      button.pressed = down;
      button.released = !down;
      const handler = down ? button.onPress : button.onRelease;
      if (typeof handler !== 'function') continue;
      try {
        handler();
      } catch (error: any) {
        logger.warn(`[Controls] A world script's ${name} handler threw: ${error?.message ?? error}`);
      }
    }
  }

  release() { }
  setActions() { }
}

