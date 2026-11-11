import { describe, expect, it } from 'vitest';
import { escapeRegExp, oneLine, stripControlChars, stripFormatChars, truncateCodePoints } from './text';

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

describe('oneLine', () => {
  it('removes bidi controls, zero-width characters, tags and the BOM, and turns line breaks into spaces', () => {
    expect(oneLine('hello \u202eabc\u202c', 100)).toBe('hello abc');
    expect(oneLine('a\u2066b\u2069c\u200ed\u200fe\u061cf', 100)).toBe('abcdef');
    expect(oneLine('zero\u200bwidth\u200cnon\u200djoiner\u2060word', 100)).toBe('zerowidthnonjoinerword');
    expect(oneLine('\ufeffstart \u{E0041}\u{E0042}tags\u00ad', 100)).toBe('start tags');
    expect(oneLine('line one\nline two\u2028three', 100)).toBe('line one line two three');
  });

  it.each([
    ['a family (ZWJ between pictographs)', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'],
    ['a profession with a skin tone', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'],
    ['a heart on fire (VS16 before the joiner)', '\u2764\uFE0F\u200D\u{1F525}'],
    ['the rainbow flag', '\u{1F3F3}\uFE0F\u200D\u{1F308}'],
    ['a country flag', '\u{1F1EF}\u{1F1F5}'],
    ["England's flag (a tag sequence)", '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
    ['a keycap', '1\uFE0F\u20E3'],
    ['skin tones', '\u{1F44B}\u{1F3FB}\u{1F44B}\u{1F3FF}'],
    ['Japanese with variation selectors', '\u845B\u{E0100}\u57CE\u5E02\u3068\u8FBB\u{E0101}\u3055\u3093'],
  ])('keeps %s whole', (_what, text) => {
    expect(oneLine(`say ${text} now`, 100)).toBe(`say ${text} now`);
    expect(stripFormatChars(text)).toBe(text);
  });

  it('drops a joiner that joins no emoji, and tags that make no flag', () => {
    expect(oneLine('\u{1F468}\u200Dx', 100)).toBe('\u{1F468}x');
    expect(oneLine('x\u200D\u{1F468}', 100)).toBe('x\u{1F468}');
    expect(oneLine('\u{1F3F4}\u{E0067}\u{E0062}', 100)).toBe('\u{1F3F4}');
  });
});
