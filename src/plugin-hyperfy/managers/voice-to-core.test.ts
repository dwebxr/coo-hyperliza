import { ModelType } from '@elizaos/core';
import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceManager } from './voice-manager';
import { BuildManager } from './build-manager';
import { hyperfyEventType, hyperfyEvents } from '../events';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';
import { connectedService, createRuntime } from '../test-support/core-runtime';
import { cooWorldSnapshot } from '../test-support/world-packets';
import { worldFromSnapshot } from '../test-support/turns';

/*
 * A voice utterance all the way through: the real VoiceManager (debounce, transcription), the
 * plugin's real voice event handler, real elizaOS core processActions, and the real scene edit
 * with the real BuildManager. The speaker's identity travels only in the voice TurnContext.
 */

afterEach(() => {
  resetUsageBudget();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const noLimits = {
  aiCallsPerHour: null,
  aiTokensPerDay: null,
  visionPerHour: null,
  ttsCharsPerDay: null,
  sttSecondsPerDay: null,
  autonomyAiPerHour: null,
  autonomyAiMinIntervalMs: 0,
};

function voiceTurn(speakerRank: number) {
  vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
  resetUsageBudget(new UsageBudget(noLimits));
  const send = vi.fn();
  const box = { isApp: true, data: { id: 'box' }, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } };
  const world: any = worldFromSnapshot(cooWorldSnapshot({ players: [{ id: 'player-1', name: 'Alice', rank: speakerRank }] }), {
    network: { send },
    controls: { goto: vi.fn().mockResolvedValue(undefined) },
    livekit: { on: vi.fn(), off: vi.fn() },
    entities: { items: new Map<string, unknown>([['box', box]]), player: { data: { id: 'coo' } }, getPlayer: () => ({ data: { name: 'Alice' } }) },
  });
  const sendMessage = vi.fn();
  const service = connectedService(world, {
    getBuildManager: () => new BuildManager({} as never),
    getMessageManager: () => ({ sendMessage }),
    getEmoteManager: () => ({ playEmote: vi.fn() }),
  });
  const plan = [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }];
  const { runtime, useModel } = createRuntime({
    service,
    models: {
      [ModelType.TRANSCRIPTION]: 'Coo, please move the box up',
      [ModelType.TEXT_LARGE]: '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY</actions></response>',
      [ModelType.OBJECT_LARGE]: { operations: plan },
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>Done!</text></response>',
    },
  });
  // Voice input needs a transcription model to be registered; useModel itself is stubbed above
  runtime.registerModel(ModelType.TRANSCRIPTION, async () => '', 'test');
  vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
  for (const handler of hyperfyEvents[hyperfyEventType.VOICE_MESSAGE_RECEIVED]) runtime.registerEvent(hyperfyEventType.VOICE_MESSAGE_RECEIVED, handler as never);
  const manager = new VoiceManager(runtime);
  vi.spyOn(manager, 'speak').mockResolvedValue('all');
  // What the LiveKit audio listener collects for a loud enough utterance
  (manager as any).userStates.set('player-1', { buffers: [Buffer.alloc(9600)], totalLength: 9600, lastActive: Date.now(), transcriptionText: '' });
  return { manager, send, useModel, box };
}

it("carries the speaker's identity from a voice utterance to the scene edit's authorization", async () => {
  const { manager, send, useModel } = voiceTurn(1);
  manager.debouncedProcessTranscription('player-1' as never);
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('entityModified', expect.objectContaining({ id: 'box', position: [0, 2, 0] })), { timeout: 5000 });
  expect(useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.TRANSCRIPTION, ModelType.TEXT_LARGE, ModelType.OBJECT_LARGE, ModelType.TEXT_SMALL]);
});

it('edits nothing for a visitor speaking the same request', async () => {
  const { manager, send, useModel, box } = voiceTurn(0);
  manager.debouncedProcessTranscription('player-1' as never);
  await vi.waitFor(() => expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_LARGE, expect.anything()), { timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(send).not.toHaveBeenCalled();
  expect(box.root.position.toArray()).toEqual([0, 0, 0]);
  expect(useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.TRANSCRIPTION, ModelType.TEXT_LARGE]);
});
