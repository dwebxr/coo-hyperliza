import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createPlayerProxy } from '../hyperfy/src/core/extras/createPlayerProxy.js';
import { AgentAvatar } from './avatar';

/*
 * The agent's avatar node has no skeleton (avatars are drawn in the render page): asked where a
 * bone is, it says it does not know, instead of answering with a position it made up.
 */
describe('AgentAvatar bone data', () => {
  it('has no bone transform to give, with or without a parent that has a position', () => {
    const avatar = new AgentAvatar({ id: 'avatar' });
    expect(avatar.getBoneTransform('head')).toBeNull();
    (avatar as any).parent = { position: new THREE.Vector3(3, 4, 5) };
    for (const bone of ['head', 'hips', 'leftHand', 'no-such-bone']) expect(avatar.getBoneTransform(bone)).toBeNull();
    // What a world script reaches through the node's proxy
    expect(avatar.getProxy().getBoneTransform('head')).toBeNull();
  });

  it("gives a world script's player.getBoneTransform (the engine's player proxy) nothing, without throwing", () => {
    const avatar = new AgentAvatar({ id: 'avatar' });
    (avatar as any).parent = { position: new THREE.Vector3(3, 4, 5) };
    // As the engine builds the player object a script sees (extras/createPlayerProxy.js)
    const player = { data: { id: 'p1', owner: 'n1' }, avatar, base: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() } };
    const proxy = createPlayerProxy({ world: { network: { id: 'n1' } } }, player);
    expect(proxy.getBoneTransform('head')).toBeNull();
  });
});
