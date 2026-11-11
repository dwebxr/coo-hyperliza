import { composeActionExamples } from '@elizaos/core';
import { expect, it } from 'vitest';
import { teleportToUserAction } from './teleport';

it('renders every teleport example line with a speaker name in the action examples prompt', () => {
  // More than the action has, so every example is rendered
  const text = composeActionExamples([teleportToUserAction], 10);
  const lines = text.split('\n').filter(Boolean);
  expect(lines).toHaveLength(6);
  for (const line of lines) expect(line).toMatch(/^[^:{}]+: \S/);
  expect(text).not.toContain('undefined');
  expect(text).toContain(': Come here!');
});
