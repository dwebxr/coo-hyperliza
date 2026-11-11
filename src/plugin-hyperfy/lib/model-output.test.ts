import { parseKeyValueXml, type Memory } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
import { plannedContent, readString, readStringList } from './model-output';

describe('readString / readStringList on real parseKeyValueXml output', () => {
  const parsed = parseKeyValueXml(
    '<response><thought>hmm</thought><text>Hi!</text><actions>REPLY,HYPERFY_GOTO_ENTITY</actions><simple>true</simple></response>'
  )!;

  it('reads the string and list fields core produces', () => {
    expect(readString(parsed, 'thought')).toBe('hmm');
    expect(readString(parsed, 'text')).toBe('Hi!');
    expect(readStringList(parsed, 'actions')).toEqual(['REPLY', 'HYPERFY_GOTO_ENTITY']);
  });

  it('returns undefined for missing fields and fields of another type', () => {
    expect(readString(parsed, 'emote')).toBeUndefined();
    expect(readString(parsed, 'actions')).toBeUndefined();
    expect(readString(parsed, 'simple')).toBeUndefined();
    expect(readStringList(parsed, 'text')).toBeUndefined();
    expect(readStringList({ actions: ['REPLY', 3] }, 'actions')).toBeUndefined();
    expect(readString({ message: 42 }, 'message')).toBeUndefined();
  });
});

describe('plannedContent', () => {
  const response = (content: Memory['content']) => ({ content }) as Memory;

  it('uses the planned text for the named action, preferring message over text', () => {
    expect(plannedContent(response({ thought: 't', text: 'from text', actions: ['REPLY', 'IGNORE'] }), 'REPLY')).toEqual({
      thought: 't',
      text: 'from text',
      actions: ['REPLY'],
    });
    expect(plannedContent(response({ message: 'from message', text: 'from text', actions: ['REPLY'] }), 'REPLY')?.text).toBe('from message');
    expect(plannedContent(response({ message: '  ', text: 'from text', actions: ['REPLY'] }), 'REPLY')?.text).toBe('from text');
  });

  it('is null when the response does not name the action or has no words to say', () => {
    expect(plannedContent(response({ text: 'hi', actions: ['IGNORE'] }), 'REPLY')).toBeNull();
    expect(plannedContent(response({ text: 'hi' }), 'REPLY')).toBeNull();
    expect(plannedContent(response({ text: '   ', actions: ['REPLY'] }), 'REPLY')).toBeNull();
    expect(plannedContent(response({ message: 5, actions: ['REPLY'] }), 'REPLY')).toBeNull();
  });
});
