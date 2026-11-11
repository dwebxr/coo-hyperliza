import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTONOMY_ACTIONS,
  actionRefusal,
  describeSceneEditsMode,
  isBuilder,
  operatorIds,
  privilegedReport,
  readSceneEditsMode,
  reportsPrivilegedAction,
  sceneEditRefusal,
  sceneEditStillAllowed,
} from './authorization';
import { type TurnContext, type TurnInit, currentTurn, neverAbortedSignal, runTurn } from './turn-context';
import { TipWallet } from './tip-wallet';
import { Ranks, trackWorldIdentity, worldIdentity } from './world-identity';
import { cooWorldSnapshot, upstreamSnapshot } from '../test-support/world-packets';
import { worldFromSnapshot } from '../test-support/turns';

const players = [
  { id: 'visitor-1', name: 'Vera', rank: Ranks.VISITOR },
  { id: 'builder-1', name: 'Bob', rank: Ranks.BUILDER },
  { id: 'admin-1', name: 'Ada', rank: Ranks.ADMIN },
];
const noOperators = {};
// Scene edits for builders switched on (they are off by default)
const builders = { HYPERFY_SCENE_EDITS: 'builders' };

describe('builder decisions from what a coo-world server sends', () => {
  it('follows each player rank when the world has an admin code and its world rank is visitor', () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players, worldRank: Ranks.VISITOR, hasAdminCode: true }));
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(false);
    expect(isBuilder(world, 'builder-1', noOperators)).toBe(true);
    expect(isBuilder(world, 'admin-1', noOperators)).toBe(true);
  });

  it("raises everyone to the world's rank setting (effectiveRank = max(player rank, world rank))", () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players, worldRank: Ranks.BUILDER, hasAdminCode: true }));
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
    expect(worldIdentity(world)?.effectiveRank('admin-1')).toBe(Ranks.ADMIN);
  });

  it('makes everyone an admin, as coo-world does, when the world has no admin code', () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players, worldRank: Ranks.VISITOR, hasAdminCode: false }));
    expect(worldIdentity(world)?.effectiveRank('visitor-1')).toBe(Ranks.ADMIN);
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
  });

  it('treats an unknown admin-code flag as present, so the world rank setting applies', () => {
    const snapshot: Record<string, unknown> = cooWorldSnapshot({ players, worldRank: Ranks.VISITOR });
    delete snapshot.hasAdminCode;
    const world = worldFromSnapshot(snapshot);
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(false);
    expect(isBuilder(world, 'builder-1', noOperators)).toBe(true);
  });

  it('counts a missing or out-of-range rank as visitor', () => {
    const snapshot = cooWorldSnapshot({ players: [{ id: 'odd-1', name: 'Odd', rank: 7 }] });
    delete (snapshot.settings as Record<string, unknown>).rank;
    const world = worldFromSnapshot(snapshot);
    expect(worldIdentity(world)?.worldRank()).toBe(Ranks.VISITOR);
    expect(isBuilder(world, 'odd-1', noOperators)).toBe(false);
  });

  it('honours rank changes sent as entityModified (e.g. /admin or an admin changing a rank)', () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players }));
    world.network.onEntityModified({ id: 'visitor-1', rank: Ranks.BUILDER });
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
    world.network.onEntityModified({ id: 'builder-1', rank: Ranks.VISITOR });
    expect(isBuilder(world, 'builder-1', noOperators)).toBe(false);
    // A modification without rank leaves it alone
    world.network.onEntityModified({ id: 'visitor-1', name: 'Vera2' });
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
  });

  it('honours a change of the world rank setting (settingsModified)', () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players }));
    world.network.onSettingsModified({ key: 'rank', value: Ranks.BUILDER });
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
    world.network.onSettingsModified({ key: 'title', value: 'x' });
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
  });

  it('knows players who join or leave later, and grants nobody who is not in the world', () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ hasAdminCode: false }));
    expect(isBuilder(world, 'newcomer', noOperators)).toBe(false);
    world.network.onEntityAdded({ ...cooWorldSnapshot({ players: [{ id: 'newcomer', name: 'N' }] }).entities[1] });
    expect(isBuilder(world, 'newcomer', noOperators)).toBe(true);
    world.network.onEntityRemoved('newcomer');
    expect(isBuilder(world, 'newcomer', noOperators)).toBe(false);
  });

  it('grants nobody by rank on a world whose identity is not tracked', () => {
    expect(isBuilder({}, 'builder-1', noOperators)).toBe(false);
  });
});

describe('an upstream Hyperfy world (roles, no rank)', () => {
  const world = () => worldFromSnapshot(upstreamSnapshot({ players: [{ id: 'p-admin', name: 'Root', roles: ['admin', 'builder'] }] }));

  it('grants nobody, not even players with admin roles', () => {
    expect(isBuilder(world(), 'p-admin', noOperators)).toBe(false);
  });

  it('grants players listed in HYPERFY_OPERATOR_IDS by player id or userId', () => {
    expect(isBuilder(world(), 'p-admin', { HYPERFY_OPERATOR_IDS: ' other , p-admin' })).toBe(true);
    const byUserId = worldFromSnapshot(upstreamSnapshot());
    byUserId.network.onEntityAdded({ id: 'player-x', type: 'player', userId: 'account-9', roles: [] });
    expect(isBuilder(byUserId, 'player-x', { HYPERFY_OPERATOR_IDS: 'account-9' })).toBe(true);
    expect(isBuilder(byUserId, 'player-x', { HYPERFY_OPERATOR_IDS: '' })).toBe(false);
  });

  it('grants a listed operator id only while that player is in the world', () => {
    const empty = worldFromSnapshot(upstreamSnapshot());
    expect(isBuilder(empty, 'p-admin', { HYPERFY_OPERATOR_IDS: 'p-admin' })).toBe(false);
    expect(isBuilder({}, 'p-admin', { HYPERFY_OPERATOR_IDS: 'p-admin' })).toBe(false);
    const present = world();
    present.network.onEntityRemoved('p-admin');
    expect(isBuilder(present, 'p-admin', { HYPERFY_OPERATOR_IDS: 'p-admin' })).toBe(false);
  });

  it('parses the operator list leniently (blanks dropped)', () => {
    expect([...operatorIds({ HYPERFY_OPERATOR_IDS: ' a, ,b,, ' })]).toEqual(['a', 'b']);
    expect(operatorIds({}).size).toBe(0);
  });
});

describe('identity tracking keeps the other network handlers working', () => {
  it('still runs the handlers it wraps, and the tip wallet chains onto it', () => {
    const engineOnEntityModified = vi.fn();
    const engineOnSnapshot = vi.fn();
    const sent: unknown[] = [];
    const world = { network: { onEntityModified: engineOnEntityModified, onSnapshot: engineOnSnapshot, send: (...args: unknown[]) => sent.push(args) } as Record<string, any> };
    trackWorldIdentity(world);
    // Created per connection after the identity is tracked, as in session/connection-session.ts
    const wallet = new TipWallet(world.network as never, privateKeyToAccount(`0x${'11'.repeat(32)}`), { host: 'world.test', selfId: () => 'coo-agent' });

    const snapshot = cooWorldSnapshot({ players });
    world.network.onSnapshot(snapshot);
    expect(engineOnSnapshot).toHaveBeenCalledWith(snapshot);

    world.network.onEntityModified({ id: 'visitor-1', rank: Ranks.BUILDER });
    world.network.onEntityModified({ id: 'coo-agent', evmTips: true });
    expect(engineOnEntityModified).toHaveBeenCalledTimes(2);
    expect(isBuilder(world, 'visitor-1', noOperators)).toBe(true);
    // The wallet saw its flag through the same chain (receiving also needs a verified sign-in)
    expect((wallet as unknown as { tipsOn: boolean }).tipsOn).toBe(true);
    wallet.stop();
  });
});

/** The context of a real turn started with `init` (the turn itself has completed). */
const realTurn = (init: TurnInit): Promise<TurnContext> => runTurn(init, async () => currentTurn()!);

describe('what a turn may do', () => {
  const builderWorld = worldFromSnapshot(cooWorldSnapshot({ players }));
  // What the checks below read of a turn; a turn's liveness has its own test further down
  const turn = (extra: Partial<TurnContext>): TurnContext => ({
    origin: 'chat',
    world: builderWorld,
    generation: 0,
    signal: neverAbortedSignal(),
    live: true,
    assertLive() {},
    ...extra,
  });

  it('edits the world only for a builder who asked in chat or voice, with scene edits on', () => {
    expect(sceneEditRefusal(turn({ requesterId: 'builder-1' }), builders)).toBeNull();
    expect(sceneEditRefusal(turn({ origin: 'voice', requesterId: 'admin-1' }), builders)).toBeNull();
    expect(sceneEditRefusal(turn({ requesterId: 'visitor-1' }), builders)).toBe('the requester is not a builder in this world');
    expect(sceneEditRefusal(turn({}), builders)).toBe('nobody asked for this edit');
    expect(sceneEditRefusal(turn({ origin: 'autonomy', requesterId: 'builder-1' }), builders)).toBe('autonomous turns never edit the world');
    expect(sceneEditRefusal(undefined, builders)).toBe('scene edits run only for a player who asked in chat or voice');
  });

  it('refuses every scene edit while HYPERFY_SCENE_EDITS is off, unset or unknown', () => {
    for (const env of [{}, { HYPERFY_SCENE_EDITS: 'off' }, { HYPERFY_SCENE_EDITS: 'everyone' }]) {
      expect(sceneEditRefusal(turn({ requesterId: 'admin-1' }), { ...env, HYPERFY_OPERATOR_IDS: 'admin-1' })).toBe('scene edits are off (HYPERFY_SCENE_EDITS)');
    }
    expect(readSceneEditsMode({ HYPERFY_SCENE_EDITS: ' Builders ' })).toEqual({ mode: 'builders' });
    expect(readSceneEditsMode({ HYPERFY_SCENE_EDITS: 'everyone' })).toEqual({ mode: 'off', problem: expect.stringMatching(/^Configuration error: unknown HYPERFY_SCENE_EDITS="everyone"/) });
    expect(describeSceneEditsMode({})).toMatch(/^\[Hyperfy\] Scene edits by request: off/);
    expect(describeSceneEditsMode(builders)).toMatch(/Scene edits by request: on for builders .*stock Hyperfy does not/);
  });

  it('checks the builder in the world the turn belongs to', () => {
    const otherWorld = worldFromSnapshot(cooWorldSnapshot({ players: [{ id: 'builder-1', name: 'Bob', rank: Ranks.VISITOR }] }));
    expect(sceneEditRefusal(turn({ world: otherWorld, requesterId: 'builder-1' }), builders)).not.toBeNull();
  });

  it('stops an authorized edit once the requester may no longer build', async () => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players }));
    const authorized = await realTurn({ origin: 'chat', world, generation: 3, requesterId: 'builder-1', signal: neverAbortedSignal() });
    expect(sceneEditStillAllowed(authorized, builders)).toBeNull();
    world.network.onEntityModified({ id: 'builder-1', rank: Ranks.VISITOR });
    expect(sceneEditStillAllowed(authorized, builders)).toBe('the requester is not a builder in this world');
    world.network.onEntityModified({ id: 'builder-1', rank: Ranks.BUILDER });
    expect(sceneEditStillAllowed(authorized, builders)).toBeNull();
    world.network.onEntityRemoved('builder-1');
    expect(sceneEditStillAllowed(authorized, builders)).toBe('the requester is not a builder in this world');
  });

  it.each([
    ['its connection ended', 'signal'],
    ['its slot ran out', 'cancel'],
  ] as const)('stops an authorized edit once %s, whoever asked', async (_what, which) => {
    const world = worldFromSnapshot(cooWorldSnapshot({ players }));
    const ends = { signal: new AbortController(), cancel: new AbortController() };
    const authorized = await realTurn({ origin: 'chat', world, generation: 3, requesterId: 'builder-1', signal: ends.signal.signal, cancel: ends.cancel.signal });
    expect(sceneEditStillAllowed(authorized, builders)).toBeNull();
    ends[which].abort();
    expect(sceneEditStillAllowed(authorized, builders)).toBe('the turn was cancelled or its connection ended');
  });

  it('keeps the check a privileged report was registered with for exactly that reply object', () => {
    const report = { refusal: () => 'no longer', instead: { text: 'neutral' } };
    const reply = reportsPrivilegedAction({ text: 'I moved the box' }, report);
    expect(privilegedReport(reply)).toBe(report);
    // A copy is another reply: only what the action handed over is checked at delivery
    expect(privilegedReport({ ...reply })).toBeUndefined();
    expect(privilegedReport({ text: 'I moved the box' })).toBeUndefined();
  });

  it('lets an autonomous turn run only the autonomy actions, and privileged actions never run outside a turn', () => {
    for (const name of AUTONOMY_ACTIONS) expect(actionRefusal(name, turn({ origin: 'autonomy' }))).toBeNull();
    expect(actionRefusal('HYPERFY_EDIT_ENTITY', turn({ origin: 'autonomy' }))).toBe('HYPERFY_EDIT_ENTITY is not allowed on an autonomous turn');
    expect(actionRefusal('HYPERFY_SCENE_PERCEPTION', turn({ origin: 'autonomy' }))).not.toBeNull();
    expect(actionRefusal('HYPERFY_EDIT_ENTITY', turn({ requesterId: 'visitor-1' }))).toBeNull();
    expect(actionRefusal('HYPERFY_EDIT_ENTITY', undefined)).toBe('HYPERFY_EDIT_ENTITY runs only inside a chat or voice turn');
    expect(actionRefusal('HYPERFY_GOTO_ENTITY', undefined)).toBeNull();
  });
});
