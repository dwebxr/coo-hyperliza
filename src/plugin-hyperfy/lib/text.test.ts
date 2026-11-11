import { describe, expect, it } from 'vitest';
import { escapeRegExp, stripControlChars, truncateCodePoints } from './text';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('escapeRegExp', () => {
  it('makes every metacharacter literal', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(escapeRegExp('a.c')).test('abc')).toBe(false);
  });
});

describe('stripControlChars', () => {
  it('removes C0, DEL and C1 controls and keeps everything else', () => {
    expect(stripControlChars('a\u0000b\u001fc\u007fd\u0080e\u009ff\n')).toBe('abcdef');
    expect(stripControlChars('tab\there', ' ')).toBe('tab here');
    expect(stripControlChars('日本語 🛹  é')).toBe('日本語 🛹  é');
  });
});

describe('truncateCodePoints', () => {
  it('returns short text unchanged', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
    expect(truncateCodePoints('', 0)).toBe('');
  });

  it('counts code points, not UTF-16 units, and never leaves half a surrogate pair', () => {
    expect(truncateCodePoints('🛹🛹🛹', 2)).toBe('🛹🛹');
    for (let max = 0; max <= 6; max++) {
      const cut = truncateCodePoints('a🛹b🛹c🛹', max);
      expect(Array.from(cut)).toHaveLength(max);
      expect(cut).not.toMatch(LONE_SURROGATE);
    }
  });

  it('fits the ellipsis within max and drops the whitespace before it', () => {
    expect(truncateCodePoints('aaaa aaaa', 6, '…')).toBe('aaaa…');
    expect(truncateCodePoints('🛹🛹🛹', 2, '…')).toBe('🛹…');
    expect(truncateCodePoints('abc', 1, '…')).toBe('…');
  });

  it('rejects limits it cannot meet', () => {
    expect(() => truncateCodePoints('abc', -1)).toThrow(RangeError);
    expect(() => truncateCodePoints('abc', 1.5)).toThrow(RangeError);
    expect(() => truncateCodePoints('abcdef', 2, '...')).toThrow(RangeError);
  });
});
