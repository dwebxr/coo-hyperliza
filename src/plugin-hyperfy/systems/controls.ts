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
/**
 * How long one walk (goto, followEntity) may take before it ends as 'timed-out'. Under the 180 s a
 * turn has (lib/chat-intake.ts), so a turn can still say that it did not get there.
 */
export const NAVIGATION_TIMEOUT_MS = 120_000;
/**
 * The farthest from the origin, on each axis, that the agent walks or teleports to. It is what
 * coo-world's server accepts as a position (TRANSFORM_LIMIT in its entityModifyPolicy.js): a
 * player's position beyond it is dropped there. A target beyond it is brought back to it.
 */
export const WORLD_COORDINATE_LIMIT = 1e6;

const clampCoordinate = (value: number) => Math.max(-WORLD_COORDINATE_LIMIT, Math.min(WORLD_COORDINATE_LIMIT, value));
const finite = (...values: unknown[]) => values.every((value) => typeof value === 'number' && Number.isFinite(value));

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

/**
 * How a walk or a teleport ended:
 *  - 'arrived': the agent is where it was sent (within the stop distance; a walk that stayed stuck
 *    ends with a teleport next to the target);
 *  - 'stopped': a stop ended it (the stop command or action, the connection ending);
 *  - 'replaced': another walk or a teleport started in its place;
 *  - 'cancelled': the signal of what it was for fired (its turn was cancelled);
 *  - 'timed-out': it did not get there within its time (NAVIGATION_TIMEOUT_MS);
 *  - 'unreachable': there is nowhere to go (the target is gone or is not a place, the agent has no
 *    player or the player's own position is not a number).
 */
export type MoveOutcome = 'arrived' | 'stopped' | 'replaced' | 'cancelled' | 'timed-out' | 'unreachable';

/** One walk (a goto, a follow, a whole random walk): ended from outside at most once. */
class ControlsToken {
  /** How the walk was ended from outside, once it was */
  ended: 'stopped' | 'replaced' | 'cancelled' | null = null;
  private readonly controller = new AbortController();
  end(outcome: 'stopped' | 'replaced' | 'cancelled') {
    if (this.ended) return;
    this.ended = outcome;
    this.controller.abort();
  }
  get aborted() { return this.ended !== null; }
  /** Fires when the walk is ended from outside: what the walk itself awaits (a recovery turn) stops with it */
  get signal() { return this.controller.signal; }
}

/**
 * `signal`: the turn (or connection) the movement is for. When it fires while the movement is
 * still the current one, the movement stops; when it has fired already, nothing is started. A
 * turn that completed leaves its signal as it is, so what it left running goes on.
 * `timeoutMs`: how long a walk may take (NAVIGATION_TIMEOUT_MS when left out).
 */
export interface MoveOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
  private _isNavigating: boolean = false;
  // <------------------------

  /** Controls bound by world scripts (bind); nothing in them refers back to this system */
  private appControls = new Set<AppControl>();

  /** The walk in progress (a goto, a follow, or a random walk between and during its legs), if any */
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

    if (isDown && !state.down) {
      state.pressed = true;
      state.released = false;
    } else if (!isDown && state.down) {
      state.released = true;
      state.pressed = false;
    }
    state.down = isDown;
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

  // --- Walks: one at a time. Every routine below checks, after each of its awaits, that its walk
  // is still the one in progress (owns) before it touches a key or the player again. ---

  /** Whether `token`'s walk is still the one in progress */
  private owns(token: ControlsToken): boolean {
    return this._currentWalkToken === token && !token.aborted;
  }

  /** How a walk that no longer owns the controls ended */
  private endOf(token: ControlsToken): MoveOutcome {
    return token.ended ?? 'replaced';
  }

  /**
   * Ends the walk in progress, if any, as `outcome`, and releases the movement keys whether or not
   * a walk is recorded as in progress: nothing of an ended walk stays pressed.
   */
  private endWalk(outcome: 'stopped' | 'replaced' | 'cancelled', reason: string): void {
    const token = this._currentWalkToken;
    this._currentWalkToken = null;
    token?.end(outcome);
    if (token || this._isNavigating || this._isRandomWalking) logger.info(`[Controls Navigation] Walk ${outcome} (${reason}).`);
    this._isRandomWalking = false;
    this._isNavigating = false;
    this.releaseMovementKeys();
  }

  private releaseMovementKeys(): void {
    for (const key of ['keyW', 'keyA', 'keyS', 'keyD', 'space', 'shiftLeft']) this.setKey(key, false);
  }

  /** Makes `token`'s walk the one in progress, in place of whatever was. */
  private begin(reason: string): ControlsToken {
    this.endWalk('replaced', reason);
    const token = new ControlsToken();
    this._currentWalkToken = token;
    return token;
  }

  /** A walk that ended by itself is no longer the one in progress (a newer one is left alone). */
  private finish(token: ControlsToken): void {
    if (this._currentWalkToken !== token) return;
    this._currentWalkToken = null;
    this._isRandomWalking = false;
  }

  // --- Random Walk Methods --- >

  /**
   * Starts the agent walking to random nearby points. Resolves once it has started; the walk goes
   * on by itself.
   */
  public async startRandomWalk(
    interval: number = RANDOM_WALK_DEFAULT_INTERVAL,
    maxDistance: number = RANDOM_WALK_DEFAULT_MAX_DISTANCE,
    duration: number = 30000,
    { signal }: MoveOptions = {}
  ) {
    if (signal?.aborted) return;
    const token = this.begin("starting a random walk");
    this._isRandomWalking = true;
    logger.info("[Controls] Random walk started.");

    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
    const untie = this.stopWith(signal, token);
    const tmpTarget = new THREE.Vector3();
    const walkLoop = async () => {
      const startTime = Date.now();
      try {
        while (this.owns(token)) {
          if ((Date.now() - startTime) >= duration) {
            logger.info("[Controls] Random walk duration reached. Stopping.");
            break;
          }
          const pos = this.world?.entities?.player?.base?.position;
          if (!pos || !finite(pos.x, pos.z)) break;
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * maxDistance;
          tmpTarget.set(clampCoordinate(pos.x + Math.cos(angle) * radius), 0, clampCoordinate(pos.z + Math.sin(angle) * radius));
          // One leg; how it ended matters only through owns() above
          await this.walk(token, () => tmpTarget, NAVIGATION_STOP_DISTANCE, { allowSprint: false, deadlineAt: startTime + duration });
          if (!this.owns(token)) break;
          await delay(Math.random() * interval);
        }
      } catch (e) {
        logger.warn(`[Random Walk] Navigation error: ${errorText(e)}`);
      } finally {
        untie();
        this.finish(token);
      }
    };

    void walkLoop();
  }

  // --- Navigation Methods --- >

  /**
   * Walks toward an entity (by ID) until within stop distance, and resolves to how that ended.
   */
  public async followEntity(entityId: string, stopDistance: number = FOLLOW_STOP_DISTANCE, { signal, timeoutMs = NAVIGATION_TIMEOUT_MS }: MoveOptions = {}): Promise<MoveOutcome> {
    if (signal?.aborted) return 'cancelled';
    const token = this.begin("starting followEntity");
    const untie = this.stopWith(signal, token);
    try {
      return await this.walk(token, () => {
        const target = this.world?.entities?.items?.get(entityId);
        return target?.base?.position ?? target?.root?.position ?? null;
      }, stopDistance, { deadlineAt: Date.now() + timeoutMs });
    } finally {
      untie();
      this.finish(token);
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
      this.endWalk('cancelled', 'what it was for was cancelled');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  /**
   * Teleports the agent to the specified position and optional rotation: 'arrived', or
   * 'unreachable' when there is no player or the position is not three finite numbers (nothing is
   * done then). A position beyond WORLD_COORDINATE_LIMIT is brought back to it.
   */
  public teleportTo(position: THREE.Vector3, rotationY?: number): MoveOutcome {
    const player = this.world?.entities?.player;
    if (!player) {
      logger.warn("[Controls] Cannot teleport: Player entity not found.");
      return 'unreachable';
    }
    if (!position || !finite(position.x, position.y, position.z)) {
      logger.warn("[Controls] Cannot teleport: the position is not three finite numbers.");
      return 'unreachable';
    }
    const destination = new THREE.Vector3(clampCoordinate(position.x), clampCoordinate(position.y), clampCoordinate(position.z));

    logger.info(`[Controls] Teleporting to ${destination.x}, ${destination.y}, ${destination.z}`);
    this.endWalk('replaced', 'teleporting');
    this.stopRotation();

    player.teleport({
      position: destination,
      rotationY: finite(rotationY) ? rotationY : undefined,
    });
    return 'arrived';
  }

  /**
   * Teleports the agent to the location of a specific entity: 'arrived', or 'unreachable' when it
   * did not teleport (no such entity, or it has no usable position).
   */
  public teleportToEntity(entityId: string): MoveOutcome {
    const target = this.world?.entities?.items?.get(entityId);
    if (!target) {
      logger.warn(`[Controls] Cannot teleport to entity ${entityId}: Entity not found.`);
      return 'unreachable';
    }

    const position = target.base?.position ?? target.root?.position;
    if (!position) {
      logger.warn(`[Controls] Cannot teleport to entity ${entityId}: Position not found.`);
      return 'unreachable';
    }

    return this.teleportTo(position);
  }

  /**
   * Walks the agent to the target X, Z coordinates and resolves to how that ended. Coordinates
   * that are not finite numbers are 'unreachable' (nothing is started); ones beyond
   * WORLD_COORDINATE_LIMIT are brought back to it.
   */
  public async goto(x: number, z: number, { signal, timeoutMs = NAVIGATION_TIMEOUT_MS }: MoveOptions = {}): Promise<MoveOutcome> {
    if (signal?.aborted) return 'cancelled';
    if (!finite(x, z)) {
      logger.warn("[Controls] Not walking: the target is not two finite numbers.");
      return 'unreachable';
    }
    const token = this.begin("starting new navigation");
    this.stopRotation();
    const target = new THREE.Vector3(clampCoordinate(x), 0, clampCoordinate(z));
    const untie = this.stopWith(signal, token);
    try {
      return await this.walk(token, () => target, NAVIGATION_STOP_DISTANCE, { deadlineAt: Date.now() + timeoutMs });
    } finally {
      untie();
      this.finish(token);
    }
  }

  /**
   * One walk of `token` toward wherever `getTargetPosition` says now, until within `stopDistance`.
   * Its keys are released when it ends, unless a newer walk has taken over by then (those keys are
   * the newer walk's).
   */
  private async walk(
    token: ControlsToken,
    getTargetPosition: () => { x: number; y: number; z: number } | null | undefined,
    stopDistance: number,
    { allowSprint = true, deadlineAt = Number.POSITIVE_INFINITY }: { allowSprint?: boolean; deadlineAt?: number } = {}
  ): Promise<MoveOutcome> {
    const tickDelay = (ms: number) => new Promise(res => setTimeout(res, ms));

    let previousPosition: THREE.Vector3 | null = null;
    let noProgressTicks = 0;
    const STUCK_THRESHOLD = 0.05;
    const MAX_NO_PROGRESS_TICKS = 10;
    let recoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 3;
    const SPRINT_DISTANCE_THRESHOLD = 15.0;
    const target = new THREE.Vector3();

    this._isNavigating = true;
    try {
      while (true) {
        if (!this.owns(token)) return this.endOf(token);
        // No player, or a position or facing that is not a number: nothing to steer
        if (!this._validatePlayerState("walk")) return 'unreachable';
        const player = this.world.entities.player;

        const targetPos = getTargetPosition();
        if (!targetPos || !finite(targetPos.x, targetPos.z)) {
          logger.warn(`[Controls] The navigation target is gone or is not a place.`);
          return 'unreachable';
        }
        target.set(clampCoordinate(targetPos.x), 0, clampCoordinate(targetPos.z));

        const playerPos = v1.copy(player.base.position);
        const distance = Math.hypot(playerPos.x - target.x, playerPos.z - target.z);

        if (distance <= stopDistance) {
          logger.info(`[Controls] Reached target within ${stopDistance}m.`);
          return 'arrived';
        }
        if (Date.now() >= deadlineAt) {
          logger.warn(`[Controls] Still ${distance.toFixed(1)}m from the target when the walk's time ran out.`);
          return 'timed-out';
        }

        // --- Stuck Detection ---
        if (previousPosition && playerPos.distanceTo(previousPosition) < STUCK_THRESHOLD) {
          noProgressTicks++;
        } else {
          noProgressTicks = 0;
        }
        (previousPosition ??= new THREE.Vector3()).copy(playerPos);

        if (noProgressTicks >= MAX_NO_PROGRESS_TICKS) {
          if (++recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
            logger.error("[Controls] Max recovery attempts reached. Teleporting to target.");
            const direction = target.clone().sub(playerPos).setY(0).normalize();
            const finalPosition = target.clone().addScaledVector(direction, -stopDistance);
            // At the height the agent stands at: the target's own height is not known here
            finalPosition.y = playerPos.y;
            player.teleport({
              position: finalPosition,
              rotationY: Math.atan2(-direction.x, -direction.z),
            });
            return 'arrived';
          }

          logger.warn("[Controls] Stuck detected. Attempting recovery rotation.");
          const randomDir: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
          // Stops with the walk (token.signal); the turn itself is bounded by its duration
          await this.rotateTo(randomDir, 500, { signal: token.signal });
          if (!this.owns(token)) return this.endOf(token);
          this.setKey('space', true);
          noProgressTicks = 0;
        } else {
          // Face toward target
          const direction = target.clone().sub(playerPos).setY(0).normalize();
          // Into the player's own quaternion: the engine keeps that object (its rotation follows it)
          player.base.quaternion.copy(q1.setFromUnitVectors(FORWARD, direction));
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
    } finally {
      // Only its own: once another walk is the one in progress, the keys down are that walk's
      if (this._currentWalkToken === token) {
        this._isNavigating = false;
        this.releaseMovementKeys();
      }
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
    // A position that is not a number would turn the agent's own facing into one
    if (!finite(targetPos.x, targetPos.z, player.base.position.x, player.base.position.z)) return;

    const direction = new THREE.Vector3(targetPos.x - player.base.position.x, 0, targetPos.z - player.base.position.z);
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
  * Stops the random walk process (and whatever walk is in progress).
  */
  public stopRandomWalk() {
    this.endWalk('stopped', 'random walk stopped');
  }

  /**
  * Stops the walk in progress and releases the movement keys.
  */
  public stopNavigation(reason: string = "commanded"): void {
    this.endWalk('stopped', reason);
  }

  public stopRotation() {
    if (this._isRotating) {
      logger.info("[Controls stopRotation] Rotation cancelled.");
      this._rotationAbortController?.end('stopped');
      this._rotationAbortController = null;
      this._isRotating = false;
      this._rotationTarget = null;
    }
  }

  /** Stops walking, following, wandering and turning, and releases the movement keys in every case. */
  public stopAllActions(reason: string = "stopAllActions called") {
    logger.info(`[Controls] Stopping all actions. Reason: ${reason}`);
    this.endWalk('stopped', reason);
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
    if (!finite(pos.x, pos.y, pos.z)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.position is not three finite numbers.`);
      return false;
    }

    if (!(quat instanceof THREE.Quaternion)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.quaternion is not a THREE.Quaternion.`);
      return false;
    }
    if (!finite(quat.x, quat.y, quat.z, quat.w)) {
      logger.error(`[Controls ${caller}] Invalid state: player.base.quaternion is not four finite numbers.`);
      return false;
    }
    // Check if quaternion is normalized (length approx 1)
    const quatLengthSq = quat.lengthSq();
    if (Math.abs(quatLengthSq - 1.0) > 0.01) { // Allow small tolerance
      logger.warn(`[Controls ${caller}] Player quaternion is not normalized (lengthSq: ${quatLengthSq.toFixed(4)}). Attempting normalization.`);
      // Attempt to normalize in place if possible, or log warning
      quat.normalize();
    }
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

