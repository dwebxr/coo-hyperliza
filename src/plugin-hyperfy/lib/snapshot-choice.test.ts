import { describe, expect, it } from 'vitest';
import { chooseSnapshot } from './snapshot-choice';

const entities = [
  { id: 'e1', name: 'Fountain' },
  { id: 'e2', name: 'Blue Fountain' },
  { id: 'p2', name: 'Alice' },
  { id: 'e3', name: 'Unnamed' },
];
const ctx = { senderId: 'p1', entities };

describe('chooseSnapshot', () => {
  it('looks all around for broad requests and by default', () => {
    expect(chooseSnapshot('Look around, anything interesting?', ctx)).toEqual({ type: 'LOOK_AROUND' });
    expect(chooseSnapshot('周りに何がある？', ctx)).toEqual({ type: 'LOOK_AROUND' });
    expect(chooseSnapshot('what do you see?', ctx)).toEqual({ type: 'LOOK_AROUND' });
    expect(chooseSnapshot(undefined, ctx)).toEqual({ type: 'LOOK_AROUND' });
  });

  it('looks at a named entity, preferring the most specific name', () => {
    expect(chooseSnapshot('Can you check the blue fountain?', ctx)).toEqual({ type: 'LOOK_AT_ENTITY', entityId: 'e2' });
    expect(chooseSnapshot('What is Alice wearing?', ctx)).toEqual({ type: 'LOOK_AT_ENTITY', entityId: 'p2' });
    expect(chooseSnapshot('look at the unnamed thing', ctx)).toEqual({ type: 'LOOK_AROUND' });
  });

  it('looks at the speaker when they ask about themselves', () => {
    expect(chooseSnapshot('How do I look? Look at me!', ctx)).toEqual({ type: 'LOOK_AT_ENTITY', entityId: 'p1' });
    expect(chooseSnapshot('私の服どう？', ctx)).toEqual({ type: 'LOOK_AT_ENTITY', entityId: 'p1' });
    expect(chooseSnapshot('look at me', { entities })).toEqual({ type: 'LOOK_AROUND' });
  });

  it('looks in a direction', () => {
    expect(chooseSnapshot("What's behind you?", ctx)).toEqual({ type: 'LOOK_DIRECTION', direction: 'back' });
    expect(chooseSnapshot('Look to your left', ctx)).toEqual({ type: 'LOOK_DIRECTION', direction: 'left' });
    expect(chooseSnapshot('右を見て', ctx)).toEqual({ type: 'LOOK_DIRECTION', direction: 'right' });
    expect(chooseSnapshot("what's up ahead?", ctx)).toEqual({ type: 'LOOK_DIRECTION', direction: 'front' });
    // "right" as in "correct" is not a direction
    expect(chooseSnapshot("that's right, what do you see?", ctx)).toEqual({ type: 'LOOK_AROUND' });
  });
});
