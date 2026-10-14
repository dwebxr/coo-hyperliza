import { System } from '../hyperfy/src/core/systems/System';
import * as THREE from 'three'

interface ActionNode extends THREE.Object3D {
  [key: string]: any;
}

export class AgentActions extends System {
  private nodes: ActionNode[] = []
  private currentNode: ActionNode | null = null;
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
  }

  getNearby(maxDistance?: number): ActionNode[] {
    const cameraPos = this.world.rig.position;

    return this.nodes.filter(node => {
      if (node.finished) return false;

      // If no distance provided, return all unfinished nodes
      if (maxDistance == null) return true;

      return node.ctx.entity.root.position.distanceTo(cameraPos) <= maxDistance;
    });
  }


  performAction(entityID?: string) {
    if (this.currentNode) {
      console.log('Already interacting with an entity. Release it first.');
      return;
    }
    const nearby = this.getNearby();
    if (!nearby.length) return;

    let target: ActionNode | undefined;

    if (entityID) {
      target = nearby.find(node => node.ctx.entity?.data?.id === entityID);
      if (!target) {
        console.log(`No nearby action node found with entity ID: ${entityID}`);
        return;
      }
    } else {
      target = nearby[0];
    }

    const control = this.world.controls;
    control.setKey('keyE', true);

    setTimeout(() => {
      if (typeof target._onTrigger === 'function') {
        target._onTrigger({ playerId: this.world.entities.player.data.id });
      }
      control.setKey('keyE', false);
      this.currentNode = target;
    }, target._duration ?? 3000);

  }


  releaseAction() {
    if (!this.currentNode) {
      console.log('No current action to release.');
      return;
    }

    console.log('Releasing current action.');
    const control = this.world.controls;
    control.setKey('keyX', true);
    control.keyX.pressed = true;
    control.keyX.onPress?.();

    if (typeof this.currentNode._onCancel === 'function') {
      this.currentNode._onCancel();
    }

    setTimeout(() => {
      control.setKey('keyX', false);
      control.keyX.released = false;
      control.keyX.onRelease?.();
      this.currentNode = null;
    }, 500);
  }

  teleportToUser(userId?: string) {
    console.log(`[Actions] Teleporting to user: ${userId}`);

    // userId is the Hyperfy entity id of the sender when known
    if (userId && this.world.entities.items.has(userId)) {
      this.world.controls.teleportToEntity(userId);
      return;
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
      this.world.controls.teleportToEntity(targetId);
    } else {
      console.warn(`[Actions] Could not find user entity to teleport to.`);
    }
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