import { describe, expect, it } from 'vitest';
import { autoTemplate, hyperfyMessageHandlerTemplate, hyperfyShouldRespondTemplate } from './templates';

describe('templates and the OpenPay shop', () => {
  it('show the shop shelf in conversation and autonomous prompts', () => {
    expect(hyperfyMessageHandlerTemplate).toContain('{{openpayStore}}');
    expect(autoTemplate('actions')).toContain('{{openpayStore}}');
  });
  it('let the reply carry which product to share', () => {
    expect(hyperfyMessageHandlerTemplate).toContain('"productId"');
    expect(hyperfyMessageHandlerTemplate).toContain('<productId>');
  });
  it('tell the should-respond check that Coo runs a shop', () => {
    expect(hyperfyShouldRespondTemplate).toContain('{{openpayShopHint}}');
  });
});
