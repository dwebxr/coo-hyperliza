import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import { characterProvider } from './character';

const message: Memory = {
  entityId: '00000000-0000-0000-0000-000000000001',
  roomId: '00000000-0000-0000-0000-000000000002',
  content: { text: 'hi' },
};
const state = { values: {}, data: { room: { type: 'WORLD' } }, text: '' } as unknown as State;
const runtimeWith = (system?: string) => ({ character: { name: 'Coo', bio: ['Friendly.'], system } }) as unknown as IAgentRuntime;

describe('characterProvider system section', () => {
  it('puts the system prompt under its header', async () => {
    const result = await characterProvider.get(runtimeWith('Be kind.'), message, state);
    expect(result.values?.system).toBe('# System Behavior\nBe kind.');
    expect(result.text).toContain('# System Behavior\nBe kind.');
  });

  it('leaves the section out when the character has no system prompt', async () => {
    const result = await characterProvider.get(runtimeWith(undefined), message, state);
    expect(result.values?.system).toBe('');
    expect(result.text).not.toContain('System Behavior');
    expect(result.text).not.toContain('undefined');
  });
});

describe("characterProvider and the character's own arrays", () => {
  it('leaves bio, post examples and message examples in the order the character has them, whatever order it shows', async () => {
    const bio = Array.from({ length: 12 }, (_, i) => `bio ${i}`);
    const postExamples = Array.from({ length: 12 }, (_, i) => `post ${i}`);
    const messageExamples = Array.from({ length: 12 }, (_, i) => [{ name: 'a', content: { text: `example ${i}` } }]);
    const topics = Array.from({ length: 12 }, (_, i) => `topic ${i}`);
    const before = structuredClone({ bio, postExamples, messageExamples, topics });
    // The arrays are shared by everything that reads the character: frozen, so sorting one in place throws
    const character = { name: 'Coo', bio: Object.freeze(bio), postExamples: Object.freeze(postExamples), messageExamples: Object.freeze(messageExamples), topics: Object.freeze(topics) };
    const runtime = { character } as unknown as IAgentRuntime;
    for (const random of [0.9, 0.1, 0.5]) {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(random);
      const result = await characterProvider.get(runtime, message, state);
      spy.mockRestore();
      expect(result.text).toContain('bio ');
    }
    expect({ bio, postExamples, messageExamples, topics }).toEqual(before);
  });
});
