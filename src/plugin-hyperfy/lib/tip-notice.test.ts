import { describe, expect, it } from 'vitest';
import { parseTipNotice, tipThanks } from './tip-notice';

describe('parseTipNotice', () => {
  it('reads public announcements of tips to the agent', () => {
    expect(parseTipNotice('Alice tipped Coo 100 JPYC', 'Coo')).toEqual({ fromName: 'Alice', amount: '100', token: 'JPYC' });
    expect(parseTipNotice('たろう tipped Coo 1.5 USDC', 'Coo')).toEqual({ fromName: 'たろう', amount: '1.5', token: 'USDC' });
  });

  it('reads the private notice sent only to the agent', () => {
    expect(parseTipNotice('(only you) Bob tipped you 10 JPYC', 'Coo')).toEqual({ fromName: 'Bob', amount: '10', token: 'JPYC' });
  });

  it('ignores tips to others and anything else', () => {
    expect(parseTipNotice('Alice tipped Bob 100 JPYC', 'Coo')).toBeNull();
    expect(parseTipNotice('Alice tipped Cool 100 JPYC', 'Coo')).toBeNull();
    expect(parseTipNotice('Welcome to Coo World!', 'Coo')).toBeNull();
    expect(parseTipNotice('', 'Coo')).toBeNull();
  });
});

describe('tipThanks', () => {
  it('thanks in Japanese or English', () => {
    const tip = { fromName: 'Alice', amount: '100', token: 'JPYC' };
    expect(tipThanks(tip, true)).toContain('Aliceさん、100 JPYCの投げゼニありがとうございます');
    expect(tipThanks(tip, false)).toContain('Thank you so much for the 100 JPYC tip, Alice');
  });
});
