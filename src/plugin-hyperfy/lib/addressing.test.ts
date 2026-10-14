import { describe, expect, it } from 'vitest';
import { isDirectlyAddressed, parseAliases } from './addressing';

describe('isDirectlyAddressed', () => {
  const names = ['Coo', 'クー'];

  it('matches an ASCII name as a whole word, case-insensitively', () => {
    expect(isDirectlyAddressed('Hey Coo, where is the shop?', names)).toBe(true);
    expect(isDirectlyAddressed('coo!', names)).toBe(true);
    expect(isDirectlyAddressed('@COO help', names)).toBe(true);
    expect(isDirectlyAddressed('Cooさん、こんにちは', names)).toBe(true);
  });

  it('does not match an ASCII name inside another word', () => {
    expect(isDirectlyAddressed('that is so cool', names)).toBe(false);
    expect(isDirectlyAddressed('raccoon', names)).toBe(false);
    expect(isDirectlyAddressed('coo_bot', names)).toBe(false);
  });

  it('matches non-ASCII names as substrings', () => {
    expect(isDirectlyAddressed('クーちゃん、案内して', names)).toBe(true);
  });

  it('handles empty input and names', () => {
    expect(isDirectlyAddressed('', names)).toBe(false);
    expect(isDirectlyAddressed(undefined, names)).toBe(false);
    expect(isDirectlyAddressed('hello', ['', '  '])).toBe(false);
  });

  it('escapes regex characters in names', () => {
    expect(isDirectlyAddressed('ask c++ about it', ['c++'])).toBe(true);
    expect(isDirectlyAddressed('ask cxx about it', ['c++'])).toBe(false);
  });
});

describe('parseAliases', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseAliases(' クー, くー ,,')).toEqual(['クー', 'くー']);
    expect(parseAliases(undefined)).toEqual([]);
    expect(parseAliases('')).toEqual([]);
  });
});
