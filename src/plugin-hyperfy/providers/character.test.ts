import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
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
