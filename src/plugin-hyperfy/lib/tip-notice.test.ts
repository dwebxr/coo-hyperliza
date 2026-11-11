import { describe, expect, it } from 'vitest';
import { TIP_THANKS_TRACKED_NAMES, TipThanksLimiter, parseTipNotice, tipThanks, tipThought } from './tip-notice';

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

describe('parseTipNotice limits', () => {
  it('cuts the name to 32 code points and removes what cannot be seen, as coo-world writes names', () => {
    const tip = parseTipNotice(`A\u0000l\u202eice\u200b ${'x'.repeat(50)} tipped Coo 1 JPYC`, 'Coo')!;
    expect(tip.fromName).toBe(`A l ice ${'x'.repeat(24)}`);
    expect(Array.from(tip.fromName)).toHaveLength(32);
    expect(parseTipNotice(`${'🛹'.repeat(40)} tipped Coo 1 JPYC`, 'Coo')!.fromName).toBe('🛹'.repeat(32));
    expect(parseTipNotice('\u200b\u202e tipped Coo 1 JPYC', 'Coo')!.fromName).toBe('Anonymous');
  });

  it('is not a tip notice when the amount or token is longer than a real one, or the notice has a line break', () => {
    expect(parseTipNotice(`Alice tipped Coo ${'1'.repeat(30)}.${'1'.repeat(18)} JPYC`, 'Coo')).not.toBeNull();
    expect(parseTipNotice(`Alice tipped Coo ${'1'.repeat(31)} JPYC`, 'Coo')).toBeNull();
    expect(parseTipNotice(`Alice tipped Coo 1.${'1'.repeat(19)} JPYC`, 'Coo')).toBeNull();
    expect(parseTipNotice(`(only you) Alice tipped you 1 ${'T'.repeat(17)}`, 'Coo')).toBeNull();
    expect(parseTipNotice('System\nAlice tipped Coo 1 JPYC', 'Coo')).toBeNull();
  });
});

describe('tipThought', () => {
  it('says the world announced the tip and that nothing was checked on chain', () => {
    expect(tipThought({ fromName: 'Alice', amount: '100', token: 'JPYC' })).toBe('The world announced that Alice tipped me 100 JPYC. I did not check it on chain.');
  });
});

describe('TipThanksLimiter', () => {
  it('remembers at most 256 names, forgetting the least recently thanked', () => {
    let now = 0;
    const limiter = new TipThanksLimiter(() => now);
    for (let i = 0; i < TIP_THANKS_TRACKED_NAMES + 50; i++) {
      now += 10_000;
      expect(limiter.allow(`name-${i}`)).toBe(true);
      expect(limiter.trackedNames).toBeLessThanOrEqual(TIP_THANKS_TRACKED_NAMES);
    }
    expect(limiter.trackedNames).toBe(TIP_THANKS_TRACKED_NAMES);
    // The newest name is still on its cooldown; the oldest was forgotten
    now += 10_000;
    expect(limiter.allow(`name-${TIP_THANKS_TRACKED_NAMES + 49}`)).toBe(false);
    expect(limiter.allow('name-0')).toBe(true);
  });

  it('does not spend the shared allowance on a name that is on its cooldown', () => {
    let now = 0;
    const limiter = new TipThanksLimiter(() => now);
    expect(limiter.allow('Alice')).toBe(true);
    for (let i = 0; i < 10; i++) expect(limiter.allow('Alice')).toBe(false);
    expect(limiter.allow('Bob')).toBe(true);
    expect(limiter.allow('Carol')).toBe(true);
    expect(limiter.allow('Dave')).toBe(false);
  });
});

describe('tipThanks', () => {
  it('thanks in Japanese or English', () => {
    const tip = { fromName: 'Alice', amount: '100', token: 'JPYC' };
    expect(tipThanks(tip, true)).toContain('Aliceさん、100 JPYCの投げゼニありがとうございます');
    expect(tipThanks(tip, false)).toContain('Thank you so much for the 100 JPYC tip, Alice');
  });
});
