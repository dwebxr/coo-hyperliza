import { System } from '../hyperfy/src/core/systems/System';
import * as THREE from 'three'
import type { MoveOutcome } from './controls'

interface ActionNode extends THREE.Object3D {
  [key: string]: any;
}

/** What performAction did: 'started' when it began an interaction, otherwise why it did nothing. */
export type PerformActionOutcome = 'started' | 'busy' | 'no-action-nodes' | 'entity-has-no-action-node';

/**
 * How long E is held on a node whose script gives no usable duration. An action node's `_duration`
 * is in seconds: the engine's own client adds each frame's delta (seconds) to the node's progress
 * until it reaches it, and its default is 0.5 (hyperfy/src/core/nodes/Action.js,
 * systems/ClientActions.js).
 */
const DEFAULT_HOLD_SECONDS = 0.5;
/**
 * The longest hold the agent makes. A node that asks for more (or for a duration that is not a
 * finite number, which the engine's client would never complete either) is not used.
 */
export const MAX_HOLD_SECONDS = 300;
/** How far around the agent getNearby looks when it is not told, and how many nodes it returns at most (the nearest). */
export const NEARBY_DEFAULT_METERS = 50;
export const NEARBY_MAX_NODES = 64;
// How long X stays down when the agent lets go of an item
const RELEASE_MS = 500;

export class AgentActions extends System {
  private nodes: ActionNode[] = []
  /** The node the agent is using (its trigger has fired), until it is released */
  private currentNode: ActionNode | null = null;
  /** The node the agent holds E on, until its trigger fires: reserved from the moment the hold starts */
  private pending: { node: ActionNode; timer: NodeJS.Timeout } | null = null;
  /** Runs out when X comes up again after a release */
  private releaseTimer: NodeJS.Timeout | null = null;
  constructor(world: any) {
    super(world);
    this.nodes = [];
  }

  register(node: ActionNode) {
    this.nodes.push(node)
  }

  unregister(node: ActionNode) {
    const idx = this.nodes.indexOf(node)
    if (idx !== -1) {
      this.nodes.splice(idx, 1)
    }
    // A node that went away (its app was rebuilt or removed) is neither triggered nor held
    if (this.pending?.node === node) this.cancelHold();
    if (this.currentNode === node && !this.releaseTimer) this.currentNode = null;
  }

  /**
   * The unfinished action nodes within `maxDistance` meters of the agent (NEARBY_DEFAULT_METERS
   * when left out or not a finite number), nearest first, at most NEARBY_MAX_NODES of them. A node
   * whose entity has no position is not near anything.
   */
  getNearby(maxDistance: number = NEARBY_DEFAULT_METERS): ActionNode[] {
    const limit = Number.isFinite(maxDistance) ? maxDistance : NEARBY_DEFAULT_METERS;
    // Where the agent stands. (The engine's own client measures from its camera rig, which nothing
    // moves in the agent.)
    const origin = this.world.entities?.player?.base?.position ?? this.world.rig?.position;
    if (!origin) return [];
    const near: { node: ActionNode; distance: number }[] = [];
    for (const node of this.nodes) {
      if (node.finished) continue;
      const position = node.ctx?.entity?.root?.position;
      const distance = typeof position?.distanceTo === 'function' ? Number(position.distanceTo(origin)) : Number.NaN;
      // Not for a distance that is not a number either
      if (distance <= limit) near.push({ node, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    return near.slice(0, NEARBY_MAX_NODES).map((entry) => entry.node);
  }

  /** How long E is held for `node`, in milliseconds, or null when the agent cannot use it (see MAX_HOLD_SECONDS). */
  private holdMs(node: ActionNode): number | null {
    const seconds = node._duration === undefined ? DEFAULT_HOLD_SECONDS : node._duration;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds > MAX_HOLD_SECONDS) return null;
    return Math.max(0, seconds) * 1000;
  }

  performAction(entityID?: string): PerformActionOutcome {
    // Also while E is held for another node, or X is still down from a release
    if (this.currentNode || this.pending || this.releaseTimer) {
      console.log('Already interacting with an entity. Release it first.');
      return 'busy';
    }
    const nearby = this.getNearby();
    if (!nearby.length) return 'no-action-nodes';

    let target: ActionNode | undefined;

    if (entityID) {
      target = nearby.find(node => node.ctx.entity?.data?.id === entityID);
      if (!target) {
        console.log(`No nearby action node found with entity ID: ${entityID}`);
        return 'entity-has-no-action-node';
      }
    } else {
      target = nearby[0];
    }
    const node = target;
    const ms = this.holdMs(node);
    if (ms === null) {
      console.log(`The action node's duration (${String(node._duration)}) is not one the agent can hold E for.`);
      return 'entity-has-no-action-node';
    }

    const control = this.world.controls;
    control.setKey('keyE', true);

    // Reserved before the timer is set: a second performAction meanwhile is 'busy'
    const timer = setTimeout(() => {
      if (this.pending?.timer !== timer) return;
      this.pending = null;
      control.setKey('keyE', false);
      this.currentNode = node;
      if (typeof node._onTrigger === 'function') {
        // A world script's callback, run from a timer: nothing else would catch what it throws
        try {
          node._onTrigger({ playerId: this.world.entities.player.data.id });
        } catch (error: any) {
          console.warn(`[Actions] The item's trigger handler threw: ${error?.message ?? error}`);
        }
      }
    }, ms);
    this.pending = { node, timer };
    return 'started';
  }

  /** Lets go of E before the trigger fired: nothing is triggered, nothing is held. */
  private cancelHold(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
    this.world.controls?.setKey?.('keyE', false);
  }

  /** False when there was nothing to release. */
  releaseAction(): boolean {
    // Still holding E: the use is called off before anything was triggered
    if (this.pending) {
      const { node } = this.pending;
      this.cancelHold();
      console.log('Stopped before the action was triggered.');
      if (typeof node._onCancel === 'function') {
        try {
          node._onCancel();
        } catch (error: any) {
          console.warn(`[Actions] The item's cancel handler threw: ${error?.message ?? error}`);
        }
      }
      return true;
    }
    // X is still down from the release in progress: it is being let go of already
    if (this.releaseTimer) return true;
    if (!this.currentNode) {
      console.log('No current action to release.');
      return false;
    }

    console.log('Releasing current action.');
    const control = this.world.controls;
    control.setKey('keyX', true);
    control.keyX.pressed = true;
    // Handlers the engine or a script put on the key are contained like every other callback here
    const contained = (what: string, call: () => void) => {
      try {
        call();
      } catch (error: any) {
        console.warn(`[Actions] ${what} threw: ${error?.message ?? error}`);
      }
    };
    contained("The X key's press handler", () => control.keyX.onPress?.());
    // World scripts hold controls of their own (AgentControls.bind): the key is pressed there too
    control.pressAppButton('keyX', true);

    // A world script's cancel handler. If it throws, the item is still let go of (keyX released,
    // nothing held) and the caller (HYPERFY_UNUSE_ITEM) is told it failed.
    let cancelFailed = false;
    let cancelError: unknown;
    if (typeof this.currentNode._onCancel === 'function') {
      try {
        this.currentNode._onCancel();
      } catch (error) {
        cancelFailed = true;
        cancelError = error;
      }
    }

    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      control.setKey('keyX', false);
      control.keyX.released = false;
      contained("The X key's release handler", () => control.keyX.onRelease?.());
      control.pressAppButton('keyX', false);
      this.currentNode = null;
    }, RELEASE_MS);
    if (cancelFailed) throw cancelError;
    return true;
  }

  // World.destroy() calls this on every system: no timer of this world fires afterwards
  destroy() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.currentNode = null;
    this.nodes = [];
    const control = this.world.controls;
    control?.setKey?.('keyE', false);
    control?.setKey?.('keyX', false);
  }

  /** 'unreachable' when there was no player to teleport to (or the teleport could not be made). */
  teleportToUser(userId?: string): MoveOutcome {
    console.log(`[Actions] Teleporting to user: ${userId}`);

    // userId is the Hyperfy entity id of the sender when known
    if (userId && this.world.entities.items.has(userId)) {
      return this.world.controls.teleportToEntity(userId);
    }

    // Fallback: the other player nearest to the agent
    const agent = this.world.entities.player;
    let targetId = null;
    let nearest = Infinity;
    this.world.entities.items.forEach((entity: any) => {
      if (!entity.isPlayer || entity === agent || !entity.base?.position) return;
      const distance = entity.base.position.distanceTo(agent.base.position);
      if (distance < nearest) {
        nearest = distance;
        targetId = entity.data.id;
      }
    });

    if (targetId) {
      return this.world.controls.teleportToEntity(targetId);
    }
    console.warn(`[Actions] Could not find user entity to teleport to.`);
    return 'unreachable';
  }

  // Framework stubs
  // init() {}
  start() { }
  preTick() { }
  preFixedUpdate() { }
  fixedUpdate() { }
  postFixedUpdate() { }
  preUpdate() { }
  update() { }
  postUpdate() { }
  lateUpdate() { }
  postLateUpdate() { }
  commit() { }
  postTick() { }
}