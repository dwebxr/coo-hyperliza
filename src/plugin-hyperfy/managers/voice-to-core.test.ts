import { ModelType } from '@elizaos/core';
import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { hyperfyEventType, hyperfyEvents } from '../events';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';
import { installWorldChat } from '../lib/world-chat';
import type { ConnectionSession } from '../session/connection-session';
import { createRuntime } from '../test-support/core-runtime';
import { serviceFor, sessionFor } from '../test-support/session';
import { cooWorldSnapshot } from '../test-support/world-packets';
import { worldFromSnapshot } from '../test-support/turns';

/*
 * A voice utterance all the way through: the real session and its real managers (audio frame,
 * pause, transcription, the conversation queue, the reply's delivery), the plugin's real voice
 * event handler, real elizaOS core processActions, and the real scene edit with the real
 * BuildManager. The speaker's identity travels only in the voice TurnContext. Nothing is
 * synthesized (no speech provider is configured), so a reply goes out as text in the real world chat.
 */

const sessions: ConnectionSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end();
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

// A loud 100 ms frame, as AgentLiveKit emits it to the listener the voice manager registered
const frame = Buffer.alloc(9600);
for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(i % 4 === 0 ? 5000 : -5000, i);

function voiceWorld(players: { id: string; name: string; rank: number }[], models: Record<string, unknown>) {
  vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
  vi.stubEnv('ELEVENLABS_XI_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  for (const method of ['log', 'info', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  resetUsageBudget(new UsageBudget(noLimits));
  const sent: [string, any][] = [];
  const box = { isApp: true, data: { id: 'box' }, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } };
  const world: any = worldFromSnapshot(cooWorldSnapshot({ players }), {
    network: { send: (name: string, data: unknown) => sent.push([name, data]) },
    chat: { msgs: [], listeners: new Set(), add: vi.fn() },
    events: { emit: vi.fn() },
    controls: { goto: vi.fn().mockResolvedValue('arrived') },
    livekit: { on: vi.fn(), off: vi.fn() },
    entities: {
      items: new Map<string, unknown>([['box', box]]),
      player: { data: { id: 'coo', name: 'Coo' } },
      getPlayer: (id: string) => {
        const player = players.find((candidate) => candidate.id === id);
        return player ? { data: { id, name: player.name } } : undefined;
      },
    },
  });
  installWorldChat(world);
  let session: ConnectionSession | null = null;
  const { runtime, useModel } = createRuntime({ service: serviceFor(() => session), models });
  // Voice input needs a transcription model to be registered; useModel itself is stubbed above
  runtime.registerModel(ModelType.TRANSCRIPTION, async () => '', 'test');
  vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
  for (const handler of hyperfyEvents[hyperfyEventType.VOICE_MESSAGE_RECEIVED]) runtime.registerEvent(hyperfyEventType.VOICE_MESSAGE_RECEIVED, handler as never);
  session = sessionFor(world, { runtime });
  sessions.push(session);
  session.voice.start();
  const hear = world.livekit.on.mock.calls.find(([event]: [string]) => event === 'audio')[1] as (data: unknown) => void;
  const speak = (participant: string, frames = 1) => {
    for (let i = 0; i < frames; i++) hear({ participant, buffer: frame });
  };
  const posted = () => sent.filter(([name]) => name === 'chatAdded').map(([, msg]) => msg.body as string);
  const calls = (type: string) => useModel.mock.calls.filter(([called]) => called === type).length;
  return { session, sent, useModel, box, speak, posted, calls };
}

function editByVoice(speakerRank: number) {
  const plan = [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }];
  return voiceWorld([{ id: 'player-1', name: 'Alice', rank: speakerRank }], {
    [ModelType.TRANSCRIPTION]: 'Coo, please move the box up',
    [ModelType.TEXT_LARGE]: '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY</actions></response>',
    [ModelType.OBJECT_LARGE]: { operations: plan },
    [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>Done!</text></response>',
  });
}

it("carries the speaker's identity from a voice utterance to the scene edit's authorization", async () => {
  const { sent, useModel, speak, posted } = editByVoice(1);
  speak('player-1');
  await vi.waitFor(() => expect(sent).toContainEqual(['entityModified', expect.objectContaining({ id: 'box', position: [0, 2, 0] })]), { timeout: 5000 });
  await vi.waitFor(() => expect(posted()).toEqual(['Moved the box up', 'Done!']), { timeout: 5000 });
  expect(useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.TRANSCRIPTION, ModelType.TEXT_LARGE, ModelType.OBJECT_LARGE, ModelType.TEXT_SMALL]);
});

it('edits nothing for a visitor speaking the same request', async () => {
  const { sent, useModel, box, speak, posted } = editByVoice(0);
  speak('player-1');
  await vi.waitFor(() => expect(posted()).toEqual(['Sorry, I can only change things in this world when a builder asks me to.']), { timeout: 5000 });
  expect(sent.filter(([name]) => name !== 'chatAdded')).toEqual([]);
  expect(box.root.position.toArray()).toEqual([0, 0, 0]);
  expect(useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.TRANSCRIPTION, ModelType.TEXT_LARGE]);
});

it('answers two people who spoke at the same time, one after the other: neither answer is paid for and then thrown away', async () => {
  // Each speaker's audio has its own length, so the transcription stub can tell them apart
  const transcripts: Record<number, string> = { 1: 'Coo, hello from Alice', 2: 'Coo, hello from Bob' };
  const answers: { prompt: string; finish: (xml: string) => void }[] = [];
  const { useModel, speak, posted, calls, session } = voiceWorld(
    [
      { id: 'alice', name: 'Alice', rank: 0 },
      { id: 'bob', name: 'Bob', rank: 0 },
    ],
    {
      [ModelType.TRANSCRIPTION]: (wav: Buffer) => transcripts[Math.round((wav.length - 44) / frame.length)],
      // The reply model answers when the test lets it: the two turns would overlap if they ran at once
      [ModelType.TEXT_LARGE]: (params: { prompt: string }) => new Promise<string>((finish) => answers.push({ prompt: params.prompt, finish })),
    }
  );
  const reply = (text: string) => `<response><thought>t</thought><actions>REPLY</actions><text>${text}</text></response>`;
  speak('alice', 1);
  speak('bob', 2);

  // Both were transcribed (at the same time); one turn asked the model, the other waits its turn
  await vi.waitFor(() => expect(calls(ModelType.TRANSCRIPTION)).toBe(2), { timeout: 5000 });
  await vi.waitFor(() => expect(answers).toHaveLength(1), { timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(answers).toHaveLength(1);
  expect(session.conversation.waiting).toBe(1);

  answers[0].finish(reply('Hello, first speaker!'));
  // The first answer is delivered before the second turn asks the model
  await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 5000 });
  expect(posted()).toEqual(['Hello, first speaker!']);
  answers[1].finish(reply('Hello, second speaker!'));
  await vi.waitFor(() => expect(posted()).toEqual(['Hello, first speaker!', 'Hello, second speaker!']), { timeout: 5000 });
  await session.conversation.idle();

  // Two transcriptions and two replies: every model call that was made was answered with
  expect(useModel.mock.calls.map(([type]) => type).sort()).toEqual([ModelType.TEXT_LARGE, ModelType.TEXT_LARGE, ModelType.TRANSCRIPTION, ModelType.TRANSCRIPTION].sort());
  expect(session.conversation.stats()).toMatchObject({ queued: 2, handled: 2 });
});
