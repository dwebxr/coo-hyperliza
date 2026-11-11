import { type Memory, type IAgentRuntime, type State, composePromptFromState } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import { SHARE_ACTION, createOpenPayStorePlugin } from '../openpay-store';
import { autoTemplate, hyperfyMessageHandlerTemplate, hyperfyShouldRespondTemplate } from './templates';

/*
 * The prompts as core renders them (composePromptFromState) from the values the shop's real
 * provider gives, over a listings answer given here: the Store itself is never asked.
 */

const board = { id: 'h_board', title: 'HoverBoard', handle: 'masia02', totalJpyc: '505', url: 'https://open-pay.jp/ja/@masia02?product=h_board&from=agent', updatedAt: 1 };
const SHELF_LINE = '- [h_board] HoverBoard — 505 JPYC (@masia02)';

const runtime = { agentId: 'agent', character: { name: 'Coo' } } as unknown as IAgentRuntime;
const fromPlayer = { entityId: 'player', content: { text: 'what do you sell?' } } as unknown as Memory;
const autonomousTick = { entityId: 'agent', content: { text: '' } } as unknown as Memory;

/** The provider's values for `message`, once the shop has loaded `items` */
async function shopValues(items: object[], message: Memory): Promise<State> {
  const listings = vi.fn(async () => new Response(JSON.stringify({ ok: true, items }), { status: 200 }));
  const plugin = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'masia02' }, { fetchImpl: listings as unknown as typeof fetch })!;
  await plugin.init!({}, {} as never);
  const [provider] = plugin.providers!;
  const [action] = plugin.actions!;
  expect(listings).toHaveBeenCalledTimes(1);
  // Loaded: the share action is offered exactly while there is something to sell
  if (items.length) await vi.waitFor(async () => expect(await action.validate(runtime, message)).toBe(true));
  else await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await provider.get(runtime, message, { values: {}, data: {}, text: '' });
  return { values: result.values ?? {}, data: {}, text: '' };
}
const render = (template: string, state: State) => composePromptFromState({ state, template });

describe('templates and the OpenPay shop', () => {
  it('show the shop shelf in conversation and autonomous prompts, with the share action only in conversation', async () => {
    const conversation = render(hyperfyMessageHandlerTemplate, await shopValues([board], fromPlayer));
    expect(conversation).toContain(SHELF_LINE);
    expect(conversation).toContain(`add ${SHARE_ACTION} after REPLY`);

    const autonomous = render(autoTemplate, await shopValues([board], autonomousTick));
    expect(autonomous).toContain(SHELF_LINE);
    expect(autonomous).toContain('Never post links or ids.');
    expect(autonomous).not.toContain(SHARE_ACTION);
  });

  it('let the reply carry which product to share, only while the shop has products', async () => {
    const selling = render(hyperfyMessageHandlerTemplate, await shopValues([board], fromPlayer));
    expect(selling).toContain(`- "productId": Only with ${SHARE_ACTION}: the id of the shop product to share. Leave blank otherwise.`);
    expect(selling).toContain(`<productId>shop product id, only with ${SHARE_ACTION}</productId>`);

    const empty = render(hyperfyMessageHandlerTemplate, await shopValues([], fromPlayer));
    expect(empty).not.toContain('productId');
    expect(empty).not.toContain(SHARE_ACTION);
    expect(empty).not.toContain('OpenPay');
    // Nothing of the placeholders is left behind either
    expect(empty).not.toContain('openpay');
    // The same prompt otherwise: the reply format is there
    expect(empty).toContain('<response>');
    expect(selling).toContain('<response>');
  });

  it('tell the should-respond check that Coo runs a shop, only while the shop has products', async () => {
    const selling = render(hyperfyShouldRespondTemplate, await shopValues([board], fromPlayer));
    expect(selling).toContain('Coo also runs a small shop (OpenPay Store); questions about buying or products are directed at them.');
    const empty = render(hyperfyShouldRespondTemplate, await shopValues([], fromPlayer));
    expect(empty).not.toMatch(/shop|openpay/i);
  });
});
