import { describe, expect, it } from 'vitest';
import { readPlanEntry } from './edit-plan';
import { SYNTHETIC_EDIT_PLANS } from './fixtures/edit-plans.synthetic';

const kindOf = (entry: unknown) => {
  const read = readPlanEntry(entry);
  return read.kind === 'operation' ? read.op.operation : read.kind;
};

describe('the scene-edit plan schema', () => {
  it.each(SYNTHETIC_EDIT_PLANS.map((fixture) => [fixture.name, fixture] as const))('reads every entry of a plausible plan (synthetic): %s', (_name, fixture) => {
    expect(fixture.plan.operations.map(kindOf)).toEqual(fixture.expected);
  });

  it('keeps what an operation needs and nothing else of the entry', () => {
    expect(readPlanEntry({ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0], speed: 9 }, description: 'Moved', extra: { nested: true } })).toEqual({
      kind: 'operation',
      op: { operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved' },
    });
    expect(readPlanEntry({ operation: 'duplicate', target: 'box', as: 'copy1' })).toEqual({ kind: 'operation', op: { operation: 'duplicate', target: 'box', as: 'copy1' } });
  });

  it("does not take the plan's word for it: an entry that says success but is no operation is invalid", () => {
    for (const entry of [
      { success: true },
      { success: true, operation: 'translate', target: 'box' },
      { success: true, operation: 'translate', target: 'box', parameters: {} },
      { success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2] } },
      { success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0, 1] } },
      { success: true, operation: 'translate', target: 'box', parameters: { position: ['0', '2', '0'] } },
      { success: true, operation: 'translate', target: 'box', parameters: { position: [0, Number.NaN, 0] } },
      { success: true, operation: 'translate', target: 'box', parameters: { position: [0, Number.POSITIVE_INFINITY, 0] } },
      { success: true, operation: 'rotate', target: 'box', parameters: { rotation: [0, 0, 1] } },
      { success: true, operation: 'rotate', target: 'box', parameters: { position: [0, 0, 0] } },
      { success: true, operation: 'scale', target: 'box', parameters: { scale: 2 } },
      { success: true, operation: 'delete' },
      { success: true, operation: 'delete', target: '' },
      { success: true, operation: 'delete', target: 7 },
      { success: true, operation: 'delete', target: ['box'] },
      { success: true, operation: 'delete', target: 'box', targetRef: 'copy1' },
      { success: true, operation: 'delete', targetRef: 'not a label!' },
      { success: true, operation: 'duplicate', target: 'box', as: '../x' },
      { success: true, operation: 'import' },
      { success: true, operation: 'import', target: { url: 'https://cdn.example.com/a.glb' } },
      { success: true, operation: 'import', targetRef: 'copy1' },
      { success: true, operation: 'import', target: 'https://cdn.example.com/a.glb', parameters: { position: 'origin' } },
      { success: true, operation: 'import', target: `https://cdn.example.com/${'a'.repeat(3000)}.glb` },
    ]) {
      const read = readPlanEntry(entry);
      expect(read.kind, JSON.stringify(entry).slice(0, 120)).toBe('invalid');
      expect((read as { problem: string }).problem.length).toBeLessThanOrEqual(160);
    }
  });

  it.each([
    [{ success: true, operation: 'explode', target: 'box' }, 'unsupported operation type'],
    [{ success: true, operation: 'Translate', target: 'box', parameters: { position: [0, 2, 0] } }, 'unsupported operation type'],
    [{ success: true, operation: 7 }, 'unsupported operation type'],
    [{ success: true }, 'unsupported operation type'],
    [null, 'not an operation object'],
    ['delete box', 'not an operation object'],
    [[{ operation: 'delete', target: 'box' }], 'not an operation object'],
    [undefined, 'not an operation object'],
  ])('says why %j is no operation', (entry, problem) => {
    expect(readPlanEntry(entry)).toEqual({ kind: 'invalid', problem });
  });

  it('reads an entry that carries no success flag, a true one, or one that is not a boolean as an operation: only its shape counts', () => {
    const move = { operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] } };
    for (const success of [undefined, true, 'false', 0, null, 'yes']) expect(kindOf({ ...move, success })).toBe('translate');
  });

  it('reads an entry the plan itself declined as declined, however complete an operation it is, and keeps its reason', () => {
    expect(readPlanEntry({ success: false, operation: 'delete', target: 'box', reason: 'kept on purpose' })).toEqual({ kind: 'declined', reason: 'kept on purpose' });
    expect(readPlanEntry({ success: false, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, reason: { why: 'x' } })).toEqual({ kind: 'declined', reason: undefined });
    expect(readPlanEntry({ success: false })).toEqual({ kind: 'declined', reason: undefined });
  });
});
